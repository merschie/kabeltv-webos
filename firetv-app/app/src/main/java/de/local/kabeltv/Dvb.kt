package de.local.kabeltv

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.charset.Charset
import java.text.Normalizer

// Kotlin-Fassung der SI-Auswertung aus proxy/epg.js: MPEG-TS-Sektionen, DVB-Texte, PAT/SDT/EIT
// und die Tunerbelegung der FRITZ!Box.

class EpgEvent(val id: Int, val start: Long, val end: Long, val title: String, val text: String)

class TunerStatus(val total: Int, val used: Int, val free: Int, val streams: Int)

object Dvb {

    const val SI_PIDS = "0,17,18"

    // ---------- Tunerbelegung ----------

    /**
     * DESCRIBE auf die Wurzel-URL listet alle laufenden Streams (auch fremder Geräte). Freie Tuner stehen
     * als "a=inactive", belegte mit Tunernummer in der fmtp-Zeile. Streams auf einer Frequenz teilen sich einen Tuner.
     */
    fun describeTuners(host: String, port: Int = 554): TunerStatus {
        Socket().use { s ->
            s.connect(InetSocketAddress(host, port), 4000)
            s.soTimeout = 4000
            s.getOutputStream().write(
                "DESCRIBE rtsp://$host:$port/ RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n".toByteArray(Charsets.ISO_8859_1)
            )
            val input = s.getInputStream()
            val head = ByteArrayOutputStream()
            var last4 = 0
            while (last4 != 0x0d0a0d0a) {
                val b = input.read()
                if (b < 0) throw IOException("RTSP DESCRIBE: Verbindung geschlossen")
                head.write(b)
                last4 = (last4 shl 8) or b
            }
            val header = head.toString("ISO-8859-1")
            val status = header.split(' ').getOrNull(1)?.toIntOrNull() ?: 0
            val len = Regex("content-length:\\s*(\\d+)", RegexOption.IGNORE_CASE).find(header)?.groupValues?.get(1)?.toInt() ?: 0
            val body = ByteArray(len)
            var got = 0
            while (got < len) {
                val n = input.read(body, got, len - got)
                if (n < 0) break
                got += n
            }
            // ohne laufende Streams antworten manche SAT>IP-Server mit 404
            if (status != 200 && status != 404) throw IOException("RTSP DESCRIBE: Status $status")
            val sdp = String(body, 0, got, Charsets.ISO_8859_1)
            // s=SatIPServer:1 <DVB-S2>,<DVB-T>,<DVB-C>
            val caps = Regex("^s=SatIPServer:1\\s+([\\d,]+)", RegexOption.MULTILINE).find(sdp)
            val total = caps?.groupValues?.get(1)?.split(',')?.sumOf { it.toIntOrNull() ?: 0 } ?: 0
            val used = mutableSetOf<String>()
            var streams = 0
            for (media in sdp.split(Regex("^m=", RegexOption.MULTILINE)).drop(1)) {
                if (!Regex("^a=sendonly", RegexOption.MULTILINE).containsMatchIn(media)) continue
                streams++
                used += Regex("tuner=(\\d+)").find(media)?.groupValues?.get(1) ?: "s$streams"
            }
            return TunerStatus(total, used.size, maxOf(0, total - used.size), streams)
        }
    }

    // ---------- CRC und Sektionen ----------

    private val CRC_TABLE = IntArray(256) { i ->
        var c = i shl 24
        repeat(8) { c = if (c and 0x80000000.toInt() != 0) (c shl 1) xor 0x04c11db7 else c shl 1 }
        c
    }

    fun crc32(b: ByteArray, off: Int, len: Int): Int {
        var crc = -1
        for (i in off until off + len) {
            crc = (crc shl 8) xor CRC_TABLE[((crc ushr 24) xor (b[i].toInt() and 0xff)) and 0xff]
        }
        return crc
    }

    class SectionReader(private val onSection: (pid: Int, s: ByteArray) -> Unit) {
        private val acc = HashMap<Int, ByteArrayOutputStream>()

        fun push(pkt: ByteArray, off: Int) {
            val pid = ((pkt[off + 1].toInt() and 0x1f) shl 8) or (pkt[off + 2].toInt() and 0xff)
            val pusi = pkt[off + 1].toInt() and 0x40 != 0
            val afc = (pkt[off + 3].toInt() shr 4) and 3
            if (afc and 1 == 0) return
            var p = off + 4
            if (afc == 3) p += 1 + (pkt[p].toInt() and 0xff)
            val end = off + 188
            if (p >= end) return

            if (pusi) {
                val ptr = pkt[p].toInt() and 0xff
                p += 1
                if (acc.containsKey(pid) && ptr > 0) consume(pid, pkt, p, minOf(p + ptr, end))
                acc[pid] = ByteArrayOutputStream()
                if (p + ptr < end) consume(pid, pkt, p + ptr, end)
            } else if (acc.containsKey(pid)) {
                consume(pid, pkt, p, end)
            }
        }

        private fun consume(pid: Int, data: ByteArray, from: Int, to: Int) {
            val cur = acc[pid] ?: return
            cur.write(data, from, to - from)
            var buf = cur.toByteArray()
            var pos = 0
            var stop = false
            while (buf.size - pos >= 3) {
                if (buf[pos].toInt() and 0xff == 0xff) { stop = true; break }
                val len = (((buf[pos + 1].toInt() and 0x0f) shl 8) or (buf[pos + 2].toInt() and 0xff)) + 3
                if (buf.size - pos < len) break
                if (len > 7 && crc32(buf, pos, len) == 0) onSection(pid, buf.copyOfRange(pos, pos + len))
                pos += len
            }
            if (stop || pos >= buf.size) {
                acc.remove(pid)
            } else if (pos > 0) {
                buf = buf.copyOfRange(pos, buf.size)
                acc[pid] = ByteArrayOutputStream().also { it.write(buf) }
            }
        }
    }

    // ---------- DVB-Texte und Zeiten ----------

    private val DIACRITICS = mapOf(
        0xc1 to '̀', 0xc2 to '́', 0xc3 to '̂', 0xc4 to '̃', 0xc5 to '̄', 0xc6 to '̆',
        0xc7 to '̇', 0xc8 to '̈', 0xca to '̊', 0xcb to '̧', 0xcd to '̋', 0xce to '̨', 0xcf to '̌'
    )

    // ISO 6937 ist der DVB-Standardzeichensatz: Akzente stehen als eigenes Byte vor dem Buchstaben.
    private fun decode6937(b: ByteArray): String {
        val sb = StringBuilder()
        var i = 0
        while (i < b.size) {
            val c = b[i].toInt() and 0xff
            val mark = DIACRITICS[c]
            if (mark != null && i + 1 < b.size) {
                i++
                sb.append(Normalizer.normalize("${(b[i].toInt() and 0xff).toChar()}$mark", Normalizer.Form.NFC))
            } else if (c == 0xfb) {
                sb.append('ß')
            } else {
                sb.append(c.toChar())
            }
            i++
        }
        return sb.toString()
    }

    fun dvbText(src: ByteArray, from: Int, to: Int): String {
        if (to <= from) return ""
        var b = src.copyOfRange(from, minOf(to, src.size))
        if (b.isEmpty()) return ""
        var enc = "iso6937"
        val c = b[0].toInt() and 0xff
        if (c < 0x20) {
            when {
                c in 0x01..0x0b -> { enc = "ISO-8859-${c + 4}"; b = b.copyOfRange(1, b.size) }
                c == 0x10 && b.size >= 3 -> { enc = "ISO-8859-${b[2].toInt() and 0xff}"; b = b.copyOfRange(3, b.size) }
                c == 0x15 -> { enc = "UTF-8"; b = b.copyOfRange(1, b.size) }
                else -> { enc = "ISO-8859-1"; b = b.copyOfRange(1, b.size) }
            }
        }
        // Bei Einbyte-Zeichensätzen sind 0x80–0x9F DVB-Steuerzeichen (0x8A = Zeilenumbruch), keine Buchstaben.
        if (enc != "UTF-8") {
            val out = ByteArrayOutputStream(b.size)
            for (x in b) {
                val v = x.toInt() and 0xff
                if (v == 0x8a) out.write(0x0a) else if (v < 0x80 || v > 0x9f) out.write(v)
            }
            b = out.toByteArray()
        }
        val s = if (enc == "iso6937") decode6937(b) else {
            runCatching { String(b, Charset.forName(enc)) }.getOrElse { String(b, Charsets.ISO_8859_1) }
        }
        return s
            .replace(Regex("[\\u0080-\\u0089\\u008b-\\u009f]"), "")
            .replace('\u008a', '\n')
            .replace(Regex("[\\u0000-\\u0009\\u000b-\\u001f]"), "")
            .trim()
    }

    private fun bcd(b: Byte): Int { val v = b.toInt() and 0xff; return (v shr 4) * 10 + (v and 0x0f) }
    private fun u16(s: ByteArray, o: Int) = ((s[o].toInt() and 0xff) shl 8) or (s[o + 1].toInt() and 0xff)
    private fun u8(s: ByteArray, o: Int) = s[o].toInt() and 0xff

    private fun dvbTime(s: ByteArray, o: Int): Long? {
        val mjd = u16(s, o)
        if (mjd == 0xffff) return null
        return (mjd - 40587L) * 86400000L + (bcd(s[o + 2]) * 3600L + bcd(s[o + 3]) * 60L + bcd(s[o + 4])) * 1000L
    }

    // ---------- SI-Tabellen ----------

    class Mux {
        var tsid: Int? = null
        var onid: Int? = null
        val programs = HashMap<Int, Int>()     // service_id -> PMT-PID
        val services = HashMap<Int, String>()  // service_id -> Name
    }

    private fun parsePat(s: ByteArray, mux: Mux) {
        mux.tsid = u16(s, 3)
        var p = 8
        while (p + 4 <= s.size - 4) {
            val prog = u16(s, p)
            if (prog != 0) mux.programs[prog] = u16(s, p + 2) and 0x1fff
            p += 4
        }
    }

    private fun parseSdt(s: ByteArray, mux: Mux) {
        mux.onid = u16(s, 8)
        val end = s.size - 4
        var p = 11
        while (p + 5 <= end) {
            val sid = u16(s, p)
            val dlen = u16(s, p + 3) and 0x0fff
            var d = p + 5
            val dend = minOf(d + dlen, end)
            while (d + 2 <= dend) {
                val tag = u8(s, d)
                val len = u8(s, d + 1)
                if (tag == 0x48 && d + 2 + len <= s.size && len >= 3) {
                    val body = d + 2
                    val provLen = u8(s, body + 1)
                    val nameLen = u8(s, body + 2 + provLen)
                    val from = body + 3 + provLen
                    mux.services[sid] = dvbText(s, from, minOf(from + nameLen, body + len))
                }
                d += 2 + len
            }
            p = dend
        }
    }

    private fun parseEit(s: ByteArray): Pair<String, List<EpgEvent>> {
        val sid = u16(s, 3)
        val tsid = u16(s, 8)
        val onid = u16(s, 10)
        val events = mutableListOf<EpgEvent>()
        val end = s.size - 4
        var p = 14
        while (p + 12 <= end) {
            val id = u16(s, p)
            val start = dvbTime(s, p + 2)
            val dur = (bcd(s[p + 7]) * 3600L + bcd(s[p + 8]) * 60L + bcd(s[p + 9])) * 1000L
            val dlen = u16(s, p + 10) and 0x0fff
            var d = p + 12
            val dend = minOf(d + dlen, end)
            var title = ""
            var text = ""
            val ext = mutableListOf<Pair<Int, String>>()
            while (d + 2 <= dend) {
                val tag = u8(s, d)
                val len = u8(s, d + 1)
                val body = d + 2
                val bend = minOf(body + len, end)
                if (tag == 0x4d && len >= 5) {
                    val nl = u8(s, body + 3)
                    title = dvbText(s, body + 4, minOf(body + 4 + nl, bend))
                    if (body + 4 + nl < bend) {
                        val tl = u8(s, body + 4 + nl)
                        text = dvbText(s, body + 5 + nl, minOf(body + 5 + nl + tl, bend))
                    }
                } else if (tag == 0x4e && len >= 6) {
                    val q = body + 5 + u8(s, body + 4)
                    if (q < bend) ext += (u8(s, body) shr 4) to dvbText(s, q + 1, minOf(q + 1 + u8(s, q), bend))
                }
                d += 2 + len
            }
            if (ext.isNotEmpty()) {
                val extText = ext.sortedBy { it.first }.joinToString("") { it.second }
                if (extText.length > text.length) text = extText
            }
            if (start != null && title.isNotEmpty()) events += EpgEvent(id, start, start + dur, title, text)
            p = dend
        }
        return "$onid:$tsid:$sid" to events
    }

    /**
     * Sammelt PAT, SDT und EIT aus den TS-Paketen einer Frequenz. Andere PIDs (Bild, Ton) werden übergangen,
     * damit das auch im laufenden Stream mitlesen kann.
     */
    class MuxCollector(private val onEvents: (key: String, events: List<EpgEvent>) -> Unit) {
        val mux = Mux()
        private val reader = SectionReader { pid, s ->
            val t = s[0].toInt() and 0xff
            runCatching {
                when {
                    pid == 0 && t == 0x00 -> parsePat(s, mux)
                    pid == 17 && t == 0x42 -> parseSdt(s, mux)
                    pid == 18 && t in 0x4e..0x6f -> {
                        val (key, ev) = parseEit(s)
                        if (ev.isNotEmpty()) onEvents(key, ev)
                    }
                }
            }
        }

        // TS-Daten eines RTP-Pakets
        fun pushPayload(buf: ByteArray, off: Int, len: Int) {
            var o = off
            while (o + 188 <= off + len) {
                if (buf[o].toInt() == 0x47) {
                    val pid = ((buf[o + 1].toInt() and 0x1f) shl 8) or (buf[o + 2].toInt() and 0xff)
                    if (pid == 0 || pid == 17 || pid == 18) reader.push(buf, o)
                }
                o += 188
            }
        }
    }
}
