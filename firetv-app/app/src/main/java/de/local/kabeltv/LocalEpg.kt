package de.local.kabeltv

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Eigener Programmführer, wie die Klasse Epg in epg.js (im webOS-Stream-Dienst):
 * Jede Frequenz wird kurz getunt (nur PAT/SDT/EIT), dazu werden die SI-Daten des laufenden Senders mitgelesen.
 * Der Scan belegt einen Tuner und startet erst, wenn die App Programminfos von hier braucht.
 */
class LocalEpg(
    private val cacheFile: File,
    private val fetchAllChannels: () -> List<Channel>,
    /** keinen Tuner nehmen, während ein Sender startet */
    private val canScan: () -> Boolean
) {
    companion object {
        private const val TAG = "KabelTV-EPG"
        private const val DWELL_MS = 12000L
        private const val INTERVAL_MS = 6 * 3600000L
        private const val RETRY_MS = 10 * 60000L
        private const val HORIZON_MS = 30 * 3600000L
    }

    private val lock = Any()
    private val events = HashMap<String, HashMap<Int, EpgEvent>>() // Dienst-Schlüssel -> Sendungen
    private val channelKey = HashMap<String, String>()              // RTSP-URL -> Dienst-Schlüssel
    private val scannedAt = HashMap<String, Long>()                 // Frequenz -> letztes vollständiges Lesen
    private var channels: List<Channel>? = null

    @Volatile var scanning = false
        private set
    @Volatile var updated: Long? = null
        private set
    @Volatile private var cancelled = false
    private val wake = Object()
    private var thread: Thread? = null
    @Volatile private var nextScan = 0L
    private var savedAt = 0L

    init {
        loadCache()
    }

    val channelCount: Int get() = synchronized(lock) { channelKey.size }

    /** Startet den Hintergrund-Scan (einmalig), erster Durchlauf nach 15 s. */
    fun ensureStarted() {
        synchronized(this) {
            if (thread != null) return
            nextScan = System.currentTimeMillis() + 15000
            thread = Thread({ loop() }, "epg-scan").apply { isDaemon = true; start() }
        }
    }

    private fun loop() {
        while (true) {
            val wait = nextScan - System.currentTimeMillis()
            if (wait > 0) {
                synchronized(wake) { runCatching { wake.wait(wait) } }
                continue
            }
            nextScan = System.currentTimeMillis() + INTERVAL_MS
            runScan()
        }
    }

    /** Bricht einen laufenden Scan ab und wartet, bis dessen Tuner frei ist; nächster Versuch in 10 Minuten. */
    fun cancelScan(): Boolean {
        if (!scanning) return false
        cancelled = true
        synchronized(wake) { wake.notifyAll() }
        val until = System.currentTimeMillis() + 8000
        while (scanning && System.currentTimeMillis() < until) Thread.sleep(50)
        nextScan = System.currentTimeMillis() + RETRY_MS
        return true
    }

    private fun sleepScan(ms: Long) {
        synchronized(wake) { if (!cancelled) runCatching { wake.wait(ms) } }
    }

    private fun runScan() {
        scanning = true
        cancelled = false
        val t0 = System.currentTimeMillis()
        var read = 0
        try {
            val all = fetchAllChannels().also { synchronized(lock) { channels = it } }
            val byFreq = LinkedHashMap<String, MutableList<Channel>>()
            for (ch in all) {
                val f = Net.freqOf(ch.url) ?: continue
                byFreq.getOrPut(f) { mutableListOf() } += ch
            }
            for ((freq, list) in byFreq) {
                // Frequenzen, die gerade erst gelesen wurden (auch beim Zuschauen), auslassen
                if (System.currentTimeMillis() - (synchronized(lock) { scannedAt[freq] } ?: 0L) < INTERVAL_MS / 2) continue
                while (!cancelled && !canScan()) sleepScan(2000)
                if (cancelled) break
                try {
                    val collector = Dvb.MuxCollector { key, ev -> addEvents(key, ev) }
                    val session = RtspSession(Net.siUrl(list[0].url)) { buf, off, len -> collector.pushPayload(buf, off, len) }
                    session.open()
                    try {
                        sleepScan(DWELL_MS)
                    } finally {
                        session.close()
                    }
                    if (cancelled) break
                    mapChannels(collector.mux, list)
                    synchronized(lock) { scannedAt[freq] = System.currentTimeMillis() }
                    read++
                    Log.i(TAG, "$freq MHz gelesen (${collector.mux.services.size} Dienste)")
                } catch (e: Exception) {
                    Log.w(TAG, "$freq MHz fehlgeschlagen: ${e.message}")
                }
                saveCache(false)
            }
            prune()
            updated = System.currentTimeMillis()
            Log.i(TAG, "Scan ${if (cancelled) "abgebrochen" else "fertig"} nach ${(System.currentTimeMillis() - t0) / 1000} s, $read Frequenzen")
        } catch (e: Exception) {
            Log.w(TAG, "Scan abgebrochen: ${e.message}")
        } finally {
            scanning = false
            saveCache(true)
        }
    }

    private fun addEvents(key: String, list: List<EpgEvent>) {
        val limit = System.currentTimeMillis() + HORIZON_MS
        synchronized(lock) {
            var m = events[key]
            for (e in list) {
                if (e.start > limit) continue
                if (m == null) m = HashMap<Int, EpgEvent>().also { events[key] = it }
                m[e.id] = e
            }
        }
    }

    private fun prune() {
        val limit = System.currentTimeMillis() - 3600000
        synchronized(lock) {
            val it = events.entries.iterator()
            while (it.hasNext()) {
                val m = it.next().value
                m.values.removeAll { e -> e.end < limit }
                if (m.isEmpty()) it.remove()
            }
        }
    }

    private fun normalize(s: String) = s.lowercase().replace(Regex("[^a-z0-9äöüß]"), "")

    private fun mapChannels(mux: Dvb.Mux, list: List<Channel>) {
        val tsid = mux.tsid ?: return
        val onid = mux.onid ?: return
        val byName = mux.services.entries.associate { normalize(it.value) to it.key }
        synchronized(lock) {
            for (ch in list) {
                var sid = byName[normalize(ch.name)]
                if (sid == null) {
                    // Ersatzweise über die PMT-PID, die in der PID-Liste der FRITZ!Box steht
                    val pids = Net.pidsOf(ch.url)
                    sid = mux.programs.entries.firstOrNull { it.value in pids }?.key
                }
                if (sid != null) channelKey[ch.url] = "$onid:$tsid:$sid"
            }
        }
    }

    /** Liest die SI-Daten aus einem laufenden Stream mit (die FRITZ!Box schickt PAT/SDT/EIT meist mit). */
    fun watch(url: String): Sniffer {
        val freq = Net.freqOf(url)
        val t0 = System.currentTimeMillis()
        val collector = Dvb.MuxCollector { key, ev -> addEvents(key, ev) }
        var mapped = false
        fun map(complete: Boolean) {
            if (collector.mux.tsid == null || collector.mux.onid == null) return
            mapped = true
            Thread {
                runCatching {
                    val all = synchronized(lock) { channels } ?: fetchAllChannels().also { synchronized(lock) { channels = it } }
                    mapChannels(collector.mux, all.filter { Net.freqOf(it.url) == freq })
                    if (complete && freq != null) synchronized(lock) { scannedAt[freq] = System.currentTimeMillis() }
                    updated = System.currentTimeMillis()
                    saveCache(false)
                }
            }.start()
        }
        return object : Sniffer {
            override fun push(buf: ByteArray, off: Int, len: Int) {
                collector.pushPayload(buf, off, len)
                if (!mapped && System.currentTimeMillis() - t0 > 5000) map(false)
            }

            override fun finish() = map(System.currentTimeMillis() - t0 >= DWELL_MS)
        }
    }

    /** Sendungen eines Senders ab jetzt, zeitlich sortiert */
    fun upcoming(url: String, limit: Int): List<EpgEvent> {
        val now = System.currentTimeMillis()
        synchronized(lock) {
            val m = events[channelKey[url]] ?: return emptyList()
            return m.values.filter { it.end > now }.sortedBy { it.start }.take(limit)
        }
    }

    // ---------- Zwischenspeicher über App-Neustarts ----------

    private fun loadCache() {
        runCatching {
            val c = JSONObject(cacheFile.readText())
            val ev = c.getJSONArray("events")
            for (i in 0 until ev.length()) {
                val pair = ev.getJSONArray(i)
                val list = pair.getJSONArray(1)
                addEvents(pair.getString(0), (0 until list.length()).map { j ->
                    val e = list.getJSONObject(j)
                    EpgEvent(e.getInt("id"), e.getLong("start"), e.getLong("end"), e.getString("title"), e.optString("text"))
                })
            }
            val ck = c.getJSONObject("channelKey")
            synchronized(lock) {
                for (k in ck.keys()) channelKey[k] = ck.getString(k)
                val sa = c.getJSONObject("scannedAt")
                for (k in sa.keys()) scannedAt[k] = sa.getLong(k)
            }
            updated = if (c.has("updated")) c.getLong("updated") else null
            prune()
            Log.i(TAG, "Zwischenspeicher geladen ($channelCount Sender)")
        }
    }

    // Höchstens einmal pro Minute schreiben, außer am Ende eines Scans
    private fun saveCache(force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && now - savedAt < 60000) return
        savedAt = now
        runCatching {
            val c = JSONObject()
            synchronized(lock) {
                updated?.let { c.put("updated", it) }
                c.put("channelKey", JSONObject(channelKey as Map<*, *>))
                c.put("scannedAt", JSONObject(scannedAt as Map<*, *>))
                val ev = JSONArray()
                for ((key, m) in events) {
                    val list = JSONArray()
                    for (e in m.values) {
                        list.put(JSONObject().put("id", e.id).put("start", e.start).put("end", e.end).put("title", e.title).put("text", e.text))
                    }
                    ev.put(JSONArray().put(key).put(list))
                }
                c.put("events", ev)
            }
            cacheFile.writeText(c.toString())
        }
    }
}
