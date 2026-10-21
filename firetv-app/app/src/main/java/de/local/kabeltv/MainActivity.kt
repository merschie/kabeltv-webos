package de.local.kabeltv

import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.ui.PlayerView
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Fire-TV-Fassung von webos-app/js/app.js: Senderlisten HD/SD/Radio, Wiedergabe direkt von der FRITZ!Box
 * (eigener RTSP-Client), Ladeanzeige, Infoleiste mit EPG und Tunern, Einstellungen, Anleitung.
 * Den Programmführer liest die App selbst aus dem Kabelsignal ([LocalEpg]).
 *
 * Die Fire-TV-Fernbedienung hat keine Farb- und Zifferntasten, deshalb: ☰ Menü = Einstellungen (Rot),
 * ⏪ ⏩ = Liste wechseln (Grün), ⏯ = Infoleiste (Gelb). Die Originaltasten gelten zusätzlich.
 */
@UnstableApi
class MainActivity : AppCompatActivity() {

    private class ListDef(val id: String, val label: String)

    private class EpgList(val channels: Map<String, List<EpgEvent>>, val fetched: Long, val scanning: Boolean)
    private class EpgDetail(val events: List<EpgEvent>, val fetched: Long)
    private class Settings(val fritzHost: String)

    private enum class Screen { TV, CHANNELS, SETTINGS }
    private enum class Phase { IDLE, STARTING, RUNNING, BUFFERING }

    companion object {
        private val LISTS = listOf(ListDef("tvhd", "HD"), ListDef("tvsd", "SD"), ListDef("radio", "Radio"))
        private const val DIRECT_TIMEOUT = 10000L
        private const val EPG_MAX_AGE = 120000L

        private const val START_HOLD = 600L      // ms echter Wiedergabe, bevor die Abdeckung verschwindet
        private const val START_MAX = 8000L      // spätestens dann weg, auch wenn die Zeit nicht weiterläuft
        private const val STALL_MS = 1000L       // so lange ohne Fortschritt gilt als Hänger
        private const val RECONNECT_MS = 20000L  // so lange hängend, dann Sender neu starten
    }

    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newCachedThreadPool()
    private lateinit var prefs: SharedPreferences
    private lateinit var settings: Settings
    private lateinit var logos: Logos
    private lateinit var localEpg: LocalEpg

    private var player: ExoPlayer? = null
    private lateinit var directSource: ProgressiveMediaSource.Factory

    // ---------- Zustand ----------

    private var listId = "tvhd"
    private val channels = HashMap<String, List<Channel>>()
    private var index = 0
    private var playToken = 0
    private var lastError: String? = null
    private val epg = HashMap<String, EpgList>()
    private val epgDetail = HashMap<String, EpgDetail>()
    private var screen = Screen.TV
    private var overlayListId = "tvhd"
    private var overlayIndex = 0

    private class Attempt(val token: Int) { var done = false }
    private var attempt: Attempt? = null
    @Volatile private var startingPlayback = false

    // ---------- Ansichten ----------

    private lateinit var playerView: PlayerView
    private lateinit var radio: View
    private lateinit var radioName: TextView
    private lateinit var status: LinearLayout
    private lateinit var statusBg: View
    private lateinit var statusLogo: ImageView
    private lateinit var statusLogoName: TextView
    private lateinit var statusText: TextView
    private lateinit var statusStep: TextView
    private lateinit var statusBar: ProgressBar
    private lateinit var error: View
    private lateinit var errorTitle: TextView
    private lateinit var errorText: TextView
    private lateinit var numInput: TextView
    private lateinit var infobar: View
    private lateinit var infoNum: TextView
    private lateinit var infoName: TextView
    private lateinit var infoList: TextView
    private lateinit var infoTuners: TextView
    private lateinit var infoClock: TextView
    private lateinit var infoEpg: View
    private lateinit var infoNowTime: TextView
    private lateinit var infoNowTitle: TextView
    private lateinit var infoNowProgress: ProgressBar
    private lateinit var infoNextTime: TextView
    private lateinit var infoNextTitle: TextView
    private lateinit var channelsPanel: View
    private lateinit var tabs: LinearLayout
    private lateinit var channelList: ListView
    private lateinit var epgChannel: TextView
    private lateinit var epgEvents: LinearLayout
    private lateinit var settingsPanel: View
    private lateinit var setFritz: EditText
    private lateinit var btnTest: Button
    private lateinit var settingsStatus: TextView
    private lateinit var tutorialView: View
    private lateinit var tutStep: TextView
    private lateinit var tutTitle: TextView
    private lateinit var tutBody: LinearLayout
    private lateinit var tutDots: LinearLayout
    private lateinit var tutHint: TextView

    private val clockFormat = SimpleDateFormat("HH:mm", Locale.GERMANY)
    private fun fmtTime(ms: Long) = clockFormat.format(Date(ms))
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun color(id: Int) = ContextCompat.getColor(this, id)
    private fun show(v: View, on: Boolean) { v.visibility = if (on) View.VISIBLE else View.GONE }

    private fun progressOf(e: EpgEvent): Int {
        val p = (System.currentTimeMillis() - e.start).toDouble() / (e.end - e.start)
        return (p.coerceIn(0.0, 1.0) * 100).toInt()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = getSharedPreferences("kabeltv", MODE_PRIVATE)
        settings = Settings(prefs.getString("fritzHost", null) ?: BuildConfig.FRITZ_HOST)
        listId = prefs.getString("listId", null) ?: "tvhd"
        logos = Logos(this)
        localEpg = LocalEpg(File(cacheDir, "epg.json"), ::fetchAllChannels) { !startingPlayback }
        directSource = ProgressiveMediaSource.Factory(
            RtspTsDataSource.Factory(rtspHooks),
            // Kabelsender haben nicht immer IDR-Frames
            DefaultExtractorsFactory().setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES)
        )
        bindViews()
        start()
        if (!prefs.getBoolean("tutorialSeen", false)) openTutorial()
    }

    override fun onStart() {
        super.onStart()
        if (player == null) createPlayer()
        handler.post(loaderTick)
        if (channels[listId] != null) play(listId, index)
    }

    // Tuner der FRITZ!Box sofort freigeben, sobald die App in den Hintergrund geht
    override fun onStop() {
        super.onStop()
        stopPlayback()
        handler.removeCallbacks(loaderTick)
        playerView.player = null
        player?.release()
        player = null
    }

    override fun onDestroy() {
        super.onDestroy()
        io.shutdownNow()
    }

    private fun bindViews() {
        playerView = findViewById(R.id.player_view)
        radio = findViewById(R.id.radio)
        radioName = findViewById(R.id.radio_name)
        status = findViewById(R.id.status)
        statusBg = findViewById(R.id.status_bg)
        statusLogo = findViewById(R.id.status_logo)
        statusLogoName = findViewById(R.id.status_logo_name)
        statusText = findViewById(R.id.status_text)
        statusStep = findViewById(R.id.status_step)
        statusBar = findViewById(R.id.status_bar)
        error = findViewById(R.id.error)
        errorTitle = findViewById(R.id.error_title)
        errorText = findViewById(R.id.error_text)
        numInput = findViewById(R.id.numinput)
        infobar = findViewById(R.id.infobar)
        infoNum = findViewById(R.id.info_num)
        infoName = findViewById(R.id.info_name)
        infoList = findViewById(R.id.info_list)
        infoTuners = findViewById(R.id.info_tuners)
        infoClock = findViewById(R.id.info_clock)
        infoEpg = findViewById(R.id.info_epg)
        infoNowTime = findViewById(R.id.info_now_time)
        infoNowTitle = findViewById(R.id.info_now_title)
        infoNowProgress = findViewById(R.id.info_now_progress)
        infoNextTime = findViewById(R.id.info_next_time)
        infoNextTitle = findViewById(R.id.info_next_title)
        channelsPanel = findViewById(R.id.channels)
        tabs = findViewById(R.id.tabs)
        channelList = findViewById(R.id.channel_list)
        epgChannel = findViewById(R.id.epg_channel)
        epgEvents = findViewById(R.id.epg_events)
        settingsPanel = findViewById(R.id.settings)
        setFritz = findViewById(R.id.set_fritz)
        btnTest = findViewById(R.id.btn_test)
        settingsStatus = findViewById(R.id.settings_status)
        tutorialView = findViewById(R.id.tutorial)
        tutStep = findViewById(R.id.tut_step)
        tutTitle = findViewById(R.id.tut_title)
        tutBody = findViewById(R.id.tut_body)
        tutDots = findViewById(R.id.tut_dots)
        tutHint = findViewById(R.id.tut_hint)

        channelList.adapter = channelAdapter
        channelList.setOnItemClickListener { _, _, position, _ ->
            overlayIndex = position
            closeChannels()
            play(overlayListId, position)
        }
        btnTest.setOnClickListener { testConnection() }
        findViewById<Button>(R.id.btn_save).setOnClickListener { saveSettings() }
        findViewById<Button>(R.id.btn_cancel).setOnClickListener { closeSettings() }
        findViewById<Button>(R.id.btn_tutorial).setOnClickListener { openTutorial() }
        tutorialView.setOnClickListener { tutorialKey(KeyEvent.KEYCODE_DPAD_CENTER) }
    }

    // ---------- Hilfsfunktionen ----------

    private fun fritzHost() = settings.fritzHost.trim().ifEmpty { BuildConfig.FRITZ_HOST }

    private fun listLabel(id: String) = LISTS.firstOrNull { it.id == id }?.label ?: id

    /** Läuft im Hintergrund, Ergebnis auf dem UI-Thread */
    private fun <T> background(work: () -> T, done: (Result<T>) -> Unit) {
        io.execute {
            val r = runCatching(work)
            handler.post { if (!isDestroyed) done(r) }
        }
    }

    private fun badge(v: TextView, colorValue: Int) {
        v.setTextColor(colorValue)
        v.background = GradientDrawable().apply {
            setStroke(dp(1), colorValue)
            cornerRadius = dp(4).toFloat()
        }
    }

    // ---------- Rückmeldungen aus dem RTSP-Client ----------

    private val rtspHooks = object : RtspTsDataSource.Hooks {
        // Sind alle Tuner belegt, während der EPG-Scan läuft, gibt der Scan seinen Tuner ab
        override fun onTunerBusy(): Boolean = localEpg.cancelScan()

        override fun onConnected(url: String) {
            handler.post { if (loaderPhase == Phase.STARTING) setLoaderBar(30, "Tuner reserviert, warte auf Daten") }
        }

        override fun onFirstData(url: String) {
            handler.post { if (loaderPhase == Phase.STARTING) setLoaderBar(40, "Sender gefunden, Daten kommen an") }
        }

        // nebenbei die SI-Daten im Stream für den Programmführer mitlesen
        override fun sniffer(url: String) = localEpg.watch(url)
    }

    // ---------- Programmführer ----------
    // Der eigene EPG-Leser wertet das Kabelsignal selbst aus. Der Hintergrund-Scan startet erst,
    // wenn Programminfos gebraucht werden, und belegt dann einen Tuner.

    private fun loadEpg(id: String) {
        val cached = epg[id]
        if (cached != null && System.currentTimeMillis() - cached.fetched < EPG_MAX_AGE) return
        val list = channels[id] ?: return
        background({
            localEpg.ensureStarted()
            val map = HashMap<String, List<EpgEvent>>()
            for (ch in list) {
                val ev = localEpg.upcoming(ch.url, 2)
                if (ev.isNotEmpty()) map[ch.url] = ev
            }
            map to (localEpg.scanning || localEpg.updated == null)
        }) { r ->
            val (map, scanning) = r.getOrNull() ?: return@background
            // Solange noch eingelesen wird, bald wieder nachfragen
            val now = System.currentTimeMillis()
            val fetched = if (map.isNotEmpty() || !scanning) now else now - EPG_MAX_AGE + 20000
            epg[id] = EpgList(map, fetched, scanning)
            if (screen == Screen.CHANNELS && overlayListId == id) channelAdapter.notifyDataSetChanged()
            if (id == listId && infobar.visibility == View.VISIBLE) renderInfoEpg()
        }
    }

    // Jetzt/Danach eines Senders; ist "jetzt" schon vorbei, rückt "danach" nach
    private fun nowNext(id: String, url: String): Pair<EpgEvent, EpgEvent?>? {
        val e = epg[id]?.channels?.get(url) ?: return null
        var now = e.getOrNull(0)
        var next = e.getOrNull(1)
        if (now != null && now.end <= System.currentTimeMillis() && next != null) { now = next; next = null }
        return now?.let { it to next }
    }

    // ---------- Senderlisten ----------

    private fun fetchList(id: String): List<Channel> {
        val list = Net.parseM3u(Net.fetchText("http://${fritzHost()}/dvb/m3u/$id.m3u"))
        if (list.isEmpty()) throw IllegalStateException("Senderliste ist leer")
        return list
    }

    // Für den eigenen EPG-Leser: alle Listen direkt von der FRITZ!Box
    private fun fetchAllChannels(): List<Channel> =
        LISTS.flatMap { Net.parseM3u(Net.fetchText("http://${fritzHost()}/dvb/m3u/${it.id}.m3u")) }

    private fun loadList(id: String, done: (Result<List<Channel>>) -> Unit) {
        channels[id]?.let { done(Result.success(it)); return }
        background({ fetchList(id) }) { r ->
            r.getOrNull()?.let { channels[id] = it }
            done(r)
        }
    }

    // ---------- Wiedergabe ----------

    private fun createPlayer() {
        // Live-TV: früh starten statt lange vorzupuffern
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(2000, 20000, 1000, 2000)
            .build()
        player = ExoPlayer.Builder(this).setLoadControl(loadControl).build().also { p ->
            p.addListener(playerListener)
            playerView.player = p
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (!isPlaying) return
            if (loaderPhase == Phase.STARTING && playingAt == 0L) {
                playingAt = System.currentTimeMillis()
                startPos = player?.currentPosition ?: 0
                setLoaderBar(75, "Wiedergabe startet")
            }
            finishAttempt(true)
        }

        override fun onTracksChanged(tracks: Tracks) {
            if (!tracks.isEmpty && loaderPhase == Phase.STARTING) setLoaderBar(50, "Sender erkannt, Puffer wird gefüllt")
        }

        override fun onRenderedFirstFrame() {
            if (loaderPhase == Phase.STARTING) setLoaderBar(65, "Erstes Bild empfangen")
        }

        override fun onPlayerError(e: PlaybackException) {
            lastError = (e.cause?.message ?: e.errorCodeName)
            val a = attempt
            if (a != null && !a.done) {
                finishAttempt(false)
            } else if (loaderPhase == Phase.RUNNING || loaderPhase == Phase.BUFFERING) {
                // Abbruch mitten in der Wiedergabe: kurz zeigen und den Sender neu starten
                showBuffering()
                val token = playToken
                handler.postDelayed({ if (token == playToken) play(listId, index) }, 2000)
            }
        }
    }

    private fun stopPlayback() {
        playToken++
        attempt = null
        startingPlayback = false
        player?.stop()
        player?.clearMediaItems()
        hideStatus()
    }

    private fun play(id: String, i: Int) {
        val list = channels[id]
        if (list.isNullOrEmpty()) return
        val idx = i.mod(list.size)

        stopPlayback()
        val token = playToken
        listId = id
        index = idx
        prefs.edit().putString("listId", id).putInt("last.$id", idx).apply()

        val ch = list[idx]
        hideError()
        setRadio(if (id == "radio") ch.name else null)
        loadEpg(id)
        showInfo()
        startLoader(ch.name, "Sender wird vorbereitet", ch.name)
        if (player == null) return

        lastError = null
        startLoader(ch.name, "Verbindung zur FRITZ!Box wird aufgebaut", ch.name)
        startingPlayback = true

        val a = Attempt(token)
        attempt = a
        onAttemptDone = { ok ->
            if (token == playToken) {
                if (ok) {
                    // Ladeanzeige verschwindet von selbst, sobald das Bild wirklich läuft
                    showInfo()
                } else {
                    hideStatus()
                    showError("Wiedergabe fehlgeschlagen", failureHint())
                }
            }
        }
        handler.postDelayed({
            if (attempt === a && !a.done) {
                lastError = "Zeitüberschreitung"
                finishAttempt(false)
            }
        }, DIRECT_TIMEOUT)

        val p = player ?: return
        p.stop()
        p.setMediaSource(directSource.createMediaSource(MediaItem.fromUri(ch.url)))
        p.prepare()
        p.playWhenReady = true
        setLoaderBar(15, "Stream wird bei der FRITZ!Box angefordert")
    }

    private var onAttemptDone: ((Boolean) -> Unit)? = null

    private fun finishAttempt(ok: Boolean) {
        val a = attempt ?: return
        if (a.done) return
        a.done = true
        if (!ok) startingPlayback = false
        val cb = onAttemptDone
        onAttemptDone = null
        cb?.invoke(ok)
    }

    private fun failureHint(): String {
        val detail = lastError?.let { "\n($it)" } ?: ""
        return "Die App konnte den Sender nicht von der FRITZ!Box abspielen.$detail\n" +
            "Möglich: alle Tuner der FRITZ!Box belegt oder die Adresse stimmt nicht.\n" +
            "▲ ▼ anderer Sender, Menütaste ☰: Einstellungen"
    }

    private fun zap(delta: Int) {
        if (channels[listId] != null) play(listId, index + delta)
    }

    private fun switchList(delta: Int) {
        val idx = LISTS.indexOfFirst { it.id == listId }
        val next = LISTS[(idx + delta).mod(LISTS.size)].id
        loadList(next) { r ->
            r.onSuccess { play(next, prefs.getInt("last.$next", 0)) }
                .onFailure { showError("Liste nicht verfügbar", it.message ?: "") }
        }
    }

    // ---------- Infoleiste ----------

    private val hideInfo = Runnable {
        show(infobar, false)
        handler.removeCallbacks(tunerTick)
    }

    // nach dem Senderwechsel belegt der neue Stream seinen Tuner erst nach ein paar Sekunden
    private val tunerTick = object : Runnable {
        override fun run() {
            updateTuners()
            handler.postDelayed(this, 2000)
        }
    }

    // Belegte/freie Tuner der FRITZ!Box per DESCRIBE (zählt auch andere Geräte mit)
    private fun updateTuners() {
        val host = fritzHost()
        background({ Dvb.describeTuners(host) }) { r ->
            val t = r.getOrNull()
            if (t == null || t.total == 0) {
                show(infoTuners, false)
                return@background
            }
            infoTuners.text = "Tuner ${t.used}/${t.total} belegt · ${t.free} frei"
            badge(infoTuners, color(if (t.free == 0) R.color.bad else if (t.free == 1) R.color.warn else R.color.ok))
            show(infoTuners, true)
        }
    }

    private fun showInfo() {
        val ch = channels[listId]?.getOrNull(index) ?: return
        infoNum.text = (index + 1).toString()
        infoName.text = ch.name
        infoList.text = listLabel(listId)
        badge(infoList, Color.parseColor("#CCCCCC"))
        infoClock.text = fmtTime(System.currentTimeMillis())
        renderInfoEpg()
        show(infobar, true)
        handler.removeCallbacks(tunerTick)
        handler.post(tunerTick)
        handler.removeCallbacks(hideInfo)
        handler.postDelayed(hideInfo, 5000)
    }

    private fun renderInfoEpg() {
        val ch = channels[listId]?.getOrNull(index)
        val nn = ch?.let { nowNext(listId, it.url) }
        show(infoEpg, nn != null)
        if (nn == null) return
        val (now, next) = nn
        infoNowTime.text = "${fmtTime(now.start)} – ${fmtTime(now.end)}"
        infoNowTitle.text = now.title
        infoNowProgress.progress = progressOf(now)
        infoNextTime.text = next?.let { fmtTime(it.start) } ?: ""
        infoNextTitle.text = next?.title ?: ""
    }

    private fun setRadio(name: String?) {
        show(radio, name != null)
        radioName.text = name ?: ""
    }

    // ---------- Ladeanzeige ----------
    // Deckt beim Senderwechsel Schwarzbild und Standbild ab, bis die Zeit im Video wirklich läuft.
    // Danach erscheint sie wieder, wenn die Wiedergabe hängt (Nachladen).

    private var loaderPhase = Phase.IDLE
    private var loaderPct = 0
    private var playingAt = 0L
    private var startPos = 0L
    private var lastPos = 0L
    private var lastMove = 0L

    private fun setLoaderBar(pct: Int, step: String? = null) {
        if (pct < loaderPct) return
        loaderPct = pct
        statusBar.progress = pct
        if (step != null) setLoaderStep(step)
    }

    private fun setLoaderStep(step: String) {
        statusStep.text = step
        show(statusStep, step.isNotEmpty())
    }

    // Hintergrund der Ladeanzeige: Senderlogo, ohne Logo der Sendername in groß
    private fun setLoaderLogo(channelName: String?) {
        val bmp = channelName?.let { logos.bitmapFor(it) }
        if (bmp != null) {
            statusLogo.setImageBitmap(bmp)
            show(statusLogo, true)
            show(statusLogoName, false)
        } else {
            statusLogo.setImageDrawable(null)
            show(statusLogo, false)
            statusLogoName.text = channelName ?: ""
            show(statusLogoName, !channelName.isNullOrEmpty())
        }
    }

    private fun startLoader(text: String, step: String, channelName: String? = null) {
        loaderPhase = Phase.STARTING
        loaderPct = 0
        playingAt = 0
        lastPos = 0
        lastMove = System.currentTimeMillis()
        statusText.text = text
        setLoaderLogo(channelName)
        status.setBackgroundResource(R.drawable.bg_cover)
        show(statusBg, true)
        statusBar.isIndeterminate = false
        statusBar.progress = 0
        setLoaderBar(5, step)
        show(status, true)
    }

    private fun showBuffering() {
        loaderPhase = Phase.BUFFERING
        statusText.text = "Lade nach …"
        setLoaderStep("Datenstrom stockt, Puffer wird aufgefüllt")
        status.background = null
        show(statusBg, false)
        statusBar.isIndeterminate = true
        show(status, true)
    }

    private fun loaderRunning() {
        loaderPhase = Phase.RUNNING
        startingPlayback = false
        show(status, false)
    }

    private fun hideStatus() {
        loaderPhase = Phase.IDLE
        show(status, false)
    }

    private val loaderTick = object : Runnable {
        override fun run() {
            handler.postDelayed(this, 250)
            val p = player ?: return
            if (loaderPhase == Phase.IDLE) return
            val now = System.currentTimeMillis()
            val pos = p.currentPosition
            val moved = pos > lastPos + 10
            lastPos = pos
            if (moved) lastMove = now

            when (loaderPhase) {
                Phase.STARTING -> {
                    if (playingAt == 0L) return
                    val played = pos - startPos
                    setLoaderBar(75 + (played.coerceIn(0, START_HOLD) * 25 / START_HOLD).toInt())
                    if (played >= START_HOLD || now - playingAt > START_MAX) loaderRunning()
                }
                Phase.RUNNING -> {
                    if (now - lastMove > STALL_MS && screen != Screen.SETTINGS) showBuffering()
                }
                Phase.BUFFERING -> {
                    val quiet = (now - lastMove) / 1000
                    if (moved) loaderRunning()
                    else if (now - lastMove > RECONNECT_MS && channels[listId] != null) play(listId, index)
                    else if (quiet >= 5) setLoaderStep("Seit $quiet s keine Daten, Neustart nach ${RECONNECT_MS / 1000} s")
                }
                Phase.IDLE -> Unit
            }
        }
    }

    private fun showStatus(text: String) = startLoader(text, "")

    private fun showError(title: String, text: String) {
        errorTitle.text = title
        errorText.text = text
        show(error, true)
    }

    private fun hideError() = show(error, false)

    // ---------- Nummerneingabe ----------

    private var numBuf = ""
    private val commitNumberRunnable = Runnable { commitNumber() }

    private fun digit(d: Int) {
        numBuf = (numBuf + d).takeLast(3)
        numInput.text = numBuf
        show(numInput, true)
        handler.removeCallbacks(commitNumberRunnable)
        handler.postDelayed(commitNumberRunnable, 1500)
    }

    private fun commitNumber() {
        handler.removeCallbacks(commitNumberRunnable)
        val n = numBuf.toIntOrNull() ?: 0
        numBuf = ""
        show(numInput, false)
        val list = channels[listId] ?: return
        if (n in 1..list.size) play(listId, n - 1)
    }

    // ---------- Senderliste ----------

    private val channelAdapter = object : BaseAdapter() {
        override fun getCount() = channels[overlayListId]?.size ?: 0
        override fun getItem(position: Int) = channels[overlayListId]?.get(position)
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val row = (convertView as? LinearLayout) ?: createChannelRow()
            val ch = channels[overlayListId]?.getOrNull(position) ?: return row
            val num = row.getChildAt(0) as TextView
            val col = row.getChildAt(1) as LinearLayout
            val name = col.getChildAt(0) as TextView
            val nowLine = col.getChildAt(1) as TextView
            val selected = position == overlayIndex
            val playing = overlayListId == listId && position == index
            num.text = (position + 1).toString()
            name.text = ch.name
            val nn = nowNext(overlayListId, ch.url)
            nowLine.text = nn?.let { "${fmtTime(it.first.start)}  ${it.first.title}" } ?: ""
            show(nowLine, nn != null)
            row.setBackgroundColor(if (selected) color(R.color.selected) else Color.TRANSPARENT)
            name.setTextColor(if (selected) Color.WHITE else if (playing) color(R.color.accent) else color(R.color.text))
            num.setTextColor(if (selected) Color.parseColor("#CFE0FF") else if (playing) color(R.color.accent) else Color.parseColor("#777777"))
            nowLine.setTextColor(if (selected) Color.parseColor("#DBE6FF") else Color.parseColor("#8A96A8"))
            return row
        }
    }

    private fun createChannelRow(): LinearLayout {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.setPadding(dp(20), dp(6), dp(20), dp(6))
        val num = TextView(this).apply {
            textSize = 14f
            gravity = Gravity.END
        }
        row.addView(num, LinearLayout.LayoutParams(dp(32), ViewGroup.LayoutParams.WRAP_CONTENT))
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(TextView(this).apply {
            textSize = 14f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        })
        col.addView(TextView(this).apply {
            textSize = 11f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, dp(1), 0, 0)
        })
        row.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(10) })
        return row
    }

    private fun openChannels() {
        screen = Screen.CHANNELS
        overlayListId = listId
        overlayIndex = index
        show(channelsPanel, true)
        renderChannels()
        loadEpg(overlayListId)
    }

    private fun closeChannels() {
        screen = Screen.TV
        show(channelsPanel, false)
    }

    private fun renderTabs() {
        tabs.removeAllViews()
        for (l in LISTS) {
            val active = l.id == overlayListId
            val t = TextView(this).apply {
                text = l.label
                textSize = 14f
                setTextColor(if (active) Color.WHITE else Color.parseColor("#AAAAAA"))
                setPadding(dp(14), dp(4), dp(14), dp(4))
                background = GradientDrawable().apply {
                    cornerRadius = dp(12).toFloat()
                    setColor(if (active) color(R.color.selected) else Color.parseColor("#0FFFFFFF"))
                }
                setOnClickListener { switchOverlayList(l.id) }
            }
            tabs.addView(t, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(6) })
        }
    }

    private fun renderChannels() {
        renderTabs()
        channelAdapter.notifyDataSetChanged()
        channelList.setSelection(maxOf(0, overlayIndex - 3))
        updateSelection()
    }

    private fun updateSelection() {
        channelAdapter.notifyDataSetChanged()
        val first = channelList.firstVisiblePosition
        val last = channelList.lastVisiblePosition
        if (channelList.childCount == 0 || overlayIndex <= first) {
            channelList.setSelection(overlayIndex)
        } else if (overlayIndex >= last) {
            val h = channelList.getChildAt(0)?.height ?: 0
            channelList.setSelectionFromTop(overlayIndex, channelList.height - h)
        }
        scheduleDetail()
    }

    // ---------- Programm des ausgewählten Senders ----------

    private val detailRunnable = Runnable { loadDetail() }

    private fun scheduleDetail() {
        handler.removeCallbacks(detailRunnable)
        val ch = channels[overlayListId]?.getOrNull(overlayIndex)
        epgChannel.text = ch?.name ?: ""
        if (ch == null) {
            epgEvents.removeAllViews()
            return
        }
        val cached = epgDetail[ch.url]
        if (cached != null) renderDetail(cached.events) else epgEvents.removeAllViews()
        if (cached != null && System.currentTimeMillis() - cached.fetched < EPG_MAX_AGE) return
        handler.postDelayed(detailRunnable, 250)
    }

    private fun loadDetail() {
        val ch = channels[overlayListId]?.getOrNull(overlayIndex) ?: return
        background({
            localEpg.ensureStarted()
            localEpg.upcoming(ch.url, 40)
        }) { r ->
            val cur = channels[overlayListId]?.getOrNull(overlayIndex)
            val visible = screen == Screen.CHANNELS && cur?.url == ch.url
            r.onSuccess { events ->
                // leere Antwort nicht lange merken, der EPG kann gerade erst eingelesen werden
                val now = System.currentTimeMillis()
                epgDetail[ch.url] = EpgDetail(events, if (events.isNotEmpty()) now else now - EPG_MAX_AGE + 20000)
                if (visible) renderDetail(events)
            }.onFailure {
                if (visible) renderDetail(null, "Programm konnte nicht geladen werden.")
            }
        }
    }

    private fun renderDetail(all: List<EpgEvent>?, message: String? = null) {
        epgEvents.removeAllViews()
        val now = System.currentTimeMillis()
        val events = (all ?: emptyList()).filter { it.end > now }
        if (events.isEmpty()) {
            epgEvents.addView(TextView(this).apply {
                textSize = 14f
                setTextColor(Color.parseColor("#777777"))
                text = message
                    ?: "Noch keine Programminfos. Die App liest den EPG nach dem Start aus dem Kabelsignal ein, das dauert ein paar Minuten."
            })
            return
        }
        for ((i, e) in events.take(10).withIndex()) {
            val running = e.start <= now
            val ev = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(6), 0, dp(6))
            }
            val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            head.addView(TextView(this).apply {
                text = fmtTime(e.start)
                textSize = 14f
                setTextColor(color(R.color.muted))
            }, LinearLayout.LayoutParams(dp(55), ViewGroup.LayoutParams.WRAP_CONTENT))
            head.addView(TextView(this).apply {
                text = e.title
                textSize = 14f
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                setTextColor(if (running) Color.WHITE else color(R.color.text))
                if (running) setTypeface(typeface, Typeface.BOLD)
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(10) })
            ev.addView(head)
            if (running) {
                val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
                    max = 100
                    progress = progressOf(e)
                    progressDrawable = ContextCompat.getDrawable(this@MainActivity, R.drawable.progress_bar)
                }
                ev.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)).apply {
                    leftMargin = dp(65)
                    topMargin = dp(5)
                })
            }
            if (i == 0 && e.text.isNotEmpty()) {
                ev.addView(TextView(this).apply {
                    text = e.text
                    textSize = 12f
                    maxLines = 6
                    ellipsize = TextUtils.TruncateAt.END
                    setLineSpacing(0f, 1.3f)
                    setTextColor(Color.parseColor("#BBBBBB"))
                    setPadding(0, dp(5), 0, 0)
                })
            }
            epgEvents.addView(ev)
        }
    }

    private fun switchOverlayList(id: String) {
        overlayListId = id
        overlayIndex = if (id == listId) index else 0
        renderChannels()
        loadList(id) { r ->
            if (overlayListId != id) return@loadList
            r.onSuccess {
                renderChannels()
                loadEpg(id)
            }.onFailure {
                epgChannel.text = "Fehler: ${it.message}"
                epgEvents.removeAllViews()
            }
        }
    }

    private fun channelsKey(code: Int): Boolean {
        val size = channels[overlayListId]?.size ?: 0
        val idx = LISTS.indexOfFirst { it.id == overlayListId }
        when (code) {
            KeyEvent.KEYCODE_DPAD_UP -> { overlayIndex = maxOf(0, overlayIndex - 1); updateSelection() }
            KeyEvent.KEYCODE_DPAD_DOWN -> { overlayIndex = maxOf(0, minOf(size - 1, overlayIndex + 1)); updateSelection() }
            KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_MEDIA_REWIND -> {
                overlayIndex = maxOf(0, overlayIndex - 10); updateSelection()
            }
            KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
                overlayIndex = maxOf(0, minOf(size - 1, overlayIndex + 10)); updateSelection()
            }
            KeyEvent.KEYCODE_DPAD_LEFT -> switchOverlayList(LISTS[(idx + LISTS.size - 1) % LISTS.size].id)
            KeyEvent.KEYCODE_DPAD_RIGHT -> switchOverlayList(LISTS[(idx + 1) % LISTS.size].id)
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                if (size > 0) {
                    closeChannels()
                    play(overlayListId, overlayIndex)
                }
            }
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_PROG_RED, KeyEvent.KEYCODE_SETTINGS -> { closeChannels(); openSettings() }
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE, KeyEvent.KEYCODE_GUIDE -> closeChannels()
            else -> return false
        }
        return true
    }

    // ---------- Einstellungen ----------

    private fun openSettings(message: String = "", bad: Boolean = false) {
        screen = Screen.SETTINGS
        setFritz.setText(settings.fritzHost)
        setSettingsStatus(message, bad)
        show(settingsPanel, true)
        btnTest.requestFocus()
    }

    private fun closeSettings() {
        currentFocus?.clearFocus()
        screen = Screen.TV
        show(settingsPanel, false)
    }

    private fun setSettingsStatus(text: String, bad: Boolean = false) {
        settingsStatus.text = text
        settingsStatus.setTextColor(
            if (text.isEmpty()) Color.parseColor("#CCCCCC") else color(if (bad) R.color.bad else R.color.ok)
        )
    }

    private fun readDraft() = Settings(setFritz.text.toString().trim().ifEmpty { BuildConfig.FRITZ_HOST })

    private fun testConnection() {
        val d = readDraft()
        setSettingsStatus("Teste …")
        settingsStatus.setTextColor(Color.parseColor("#CCCCCC"))
        background({
            val lines = mutableListOf<String>()
            var bad = false
            runCatching { Net.parseM3u(Net.fetchText("http://${d.fritzHost}/dvb/m3u/tvhd.m3u", 5000)).size }
                .onSuccess { lines += "FRITZ!Box: OK ($it HD-Sender)" }
                .onFailure { lines += "FRITZ!Box: nicht erreichbar (${it.message})"; bad = true }
            runCatching { Dvb.describeTuners(d.fritzHost) }
                .onSuccess { lines += "Tuner: ${it.used} von ${it.total} belegt" }
                .onFailure { lines += "Tuner: keine Angabe (${it.message})" }
            lines.joinToString("\n") to bad
        }) { r ->
            r.onSuccess { (text, bad) -> if (screen == Screen.SETTINGS) setSettingsStatus(text, bad) }
        }
    }

    private fun saveSettings() {
        val d = readDraft()
        val changed = d.fritzHost != settings.fritzHost
        settings = d
        // proxyUrl und mode stammen aus Versionen mit Proxy
        prefs.edit().putString("fritzHost", d.fritzHost).remove("proxyUrl").remove("mode").apply()
        closeSettings()
        if (changed) {
            channels.clear()
            epg.clear()
            epgDetail.clear()
            start()
        }
    }

    // ---------- Anleitung ----------

    private class TutPage(val title: String, val rows: List<Pair<String, String>>)

    private val tutorial = listOf(
        TutPage("Willkommen bei KabelBox TV", listOf(
            "" to "Live-Fernsehen und Radio direkt von der FRITZ!Box – alles mit der normalen Fernbedienung.",
            "" to "Die nächsten Seiten zeigen kurz, welche Taste was macht. Das Bild läuft im Hintergrund schon los.",
            "◀ ▶" to "blättern, OK geht weiter, Zurück überspringt die Anleitung"
        )),
        TutPage("Sender wechseln", listOf(
            "▲ ▼" to "nächster bzw. vorheriger Sender",
            "⏪ ⏩" to "zwischen den Listen HD, SD und Radio wechseln",
            "0 – 9" to "nur bei Fernbedienungen mit Zifferntasten: Sendernummer direkt eingeben"
        )),
        TutPage("Senderliste mit Programm", listOf(
            "OK / ◀ ▶" to "Senderliste öffnen, rechts steht das Programm des gewählten Senders",
            "◀ ▶" to "in der Liste: HD, SD oder Radio",
            "▲ ▼ / ⏪ ⏩" to "Sender auswählen, mit ⏪ ⏩ in Zehnerschritten",
            "OK" to "ausgewählten Sender abspielen, Zurück schließt die Liste"
        )),
        TutPage("Infoleiste", listOf(
            "⏯" to "zeigt Sender, was gerade läuft und was danach kommt",
            "HD / SD / Radio" to "aus welcher Senderliste der Sender stammt",
            "Tuner" to "wie viele Tuner der FRITZ!Box belegt bzw. frei sind (zählt auch andere Geräte mit)"
        )),
        TutPage("Einstellungen", listOf(
            "☰ Menü" to "Einstellungen öffnen: Adresse der FRITZ!Box",
            "Verbindung testen" to "prüft, ob die FRITZ!Box erreichbar ist und wie viele Tuner frei sind",
            "Anleitung" to "diese Anleitung jederzeit erneut anzeigen",
            "Zurück" to "im Fernsehbild beendet die App"
        ))
    )

    private var tutorialOpen = false
    private var tutorialPage = 0

    private fun openTutorial() {
        currentFocus?.clearFocus()
        tutorialOpen = true
        tutorialPage = 0
        renderTutorial()
        show(tutorialView, true)
    }

    private fun closeTutorial() {
        tutorialOpen = false
        show(tutorialView, false)
        prefs.edit().putBoolean("tutorialSeen", true).apply()
        if (screen == Screen.SETTINGS) btnTest.requestFocus()
    }

    private fun renderTutorial() {
        val p = tutorial[tutorialPage]
        tutStep.text = "Anleitung ${tutorialPage + 1} / ${tutorial.size}"
        tutTitle.text = p.title
        tutBody.removeAllViews()
        for ((key, text) in p.rows) {
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            if (key.isNotEmpty()) {
                row.addView(TextView(this).apply {
                    this.text = key
                    textSize = 14f
                    gravity = Gravity.CENTER
                    setTextColor(Color.WHITE)
                    setPadding(dp(8), dp(1), dp(8), dp(1))
                    background = GradientDrawable().apply {
                        setColor(color(R.color.field))
                        setStroke(dp(1), color(R.color.field_border))
                        cornerRadius = dp(5).toFloat()
                    }
                    minWidth = dp(130)
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(14) })
            }
            row.addView(TextView(this).apply {
                this.text = text
                textSize = 14f
                setLineSpacing(0f, 1.2f)
                setTextColor(Color.parseColor("#DDDDDD"))
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            tutBody.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(9) })
        }
        tutDots.removeAllViews()
        for (i in tutorial.indices) {
            tutDots.addView(View(this).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(if (i == tutorialPage) color(R.color.accent) else Color.parseColor("#33FFFFFF"))
                }
            }, LinearLayout.LayoutParams(dp(7), dp(7)).apply { leftMargin = dp(4); rightMargin = dp(4) })
        }
        val ok = if (tutorialPage < tutorial.size - 1) "Weiter" else "Fertig"
        tutHint.text = "◀▶ Blättern    OK $ok    Zurück Überspringen"
    }

    private fun tutorialKey(code: Int): Boolean {
        when (code) {
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                if (tutorialPage < tutorial.size - 1) { tutorialPage++; renderTutorial() } else closeTutorial()
            KeyEvent.KEYCODE_DPAD_LEFT -> if (tutorialPage > 0) { tutorialPage--; renderTutorial() }
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> closeTutorial()
            else -> Unit // übrige Tasten nicht ans Fernsehbild durchreichen
        }
        return true
    }

    // ---------- Tasten ----------

    private fun tvKey(code: Int): Boolean {
        if (code in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9) { digit(code - KeyEvent.KEYCODE_0); return true }
        if (code in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9) { digit(code - KeyEvent.KEYCODE_NUMPAD_0); return true }
        when (code) {
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP -> zap(1)
            KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN -> zap(-1)
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                if (numBuf.isNotEmpty()) commitNumber() else openChannels()
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_GUIDE -> openChannels()
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_PROG_RED, KeyEvent.KEYCODE_SETTINGS -> openSettings()
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_PROG_GREEN -> switchList(1)
            KeyEvent.KEYCODE_MEDIA_REWIND -> switchList(-1)
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE,
            KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_PROG_YELLOW -> showInfo()
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE ->
                if (error.visibility == View.VISIBLE) hideError() else finish()
            else -> return false
        }
        return true
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        // Lautstärke, Home usw. bleiben beim System
        if (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN ||
            code == KeyEvent.KEYCODE_VOLUME_MUTE || code == KeyEvent.KEYCODE_HOME
        ) return super.dispatchKeyEvent(event)

        if (screen == Screen.SETTINGS && !tutorialOpen) {
            // Das Loslassen der Taste, mit der die Einstellungen geöffnet wurden, darf sie nicht gleich wieder schließen
            if (event.action == KeyEvent.ACTION_UP && consumedKeys.remove(code)) return true
            // Im Formular übernimmt die normale Fokus-Steuerung, nur Zurück/Menü schließen
            if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_MENU) {
                if (event.action == KeyEvent.ACTION_UP) closeSettings()
                return true
            }
            return super.dispatchKeyEvent(event)
        }
        if (event.action == KeyEvent.ACTION_UP) {
            return consumedKeys.remove(code) || super.dispatchKeyEvent(event)
        }
        if (event.action != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(event)
        val handled = when {
            tutorialOpen -> tutorialKey(code)
            screen == Screen.CHANNELS -> channelsKey(code)
            else -> tvKey(code)
        }
        if (handled) consumedKeys += code
        return handled || super.dispatchKeyEvent(event)
    }

    // Tasten, deren Drücken die App verarbeitet hat; das Loslassen gehört dann auch ihr
    private val consumedKeys = HashSet<Int>()

    // ---------- Start ----------

    private fun start() {
        val id = listId
        showStatus("Lade Senderliste …")
        loadList(id) { r ->
            r.onSuccess {
                index = prefs.getInt("last.$id", 0)
                play(id, index)
            }.onFailure {
                hideStatus()
                openSettings(
                    "Senderliste konnte nicht geladen werden:\n${it.message}\nBitte Adresse der FRITZ!Box prüfen.",
                    true
                )
            }
        }
    }
}
