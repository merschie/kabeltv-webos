package de.local.kabeltv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import kotlin.concurrent.thread

class DvbTest {

    // ---------- Hilfen zum Bauen von Sektionen und TS-Paketen ----------

    private fun withCrc(body: ByteArray): ByteArray {
        val crc = Dvb.crc32(body, 0, body.size)
        return body + byteArrayOf((crc ushr 24).toByte(), (crc ushr 16).toByte(), (crc ushr 8).toByte(), crc.toByte())
    }

    /** Sektion mit Kopf (table_id, section_length) und Prüfsumme */
    private fun section(tableId: Int, payloadAfterLength: ByteArray): ByteArray {
        val len = payloadAfterLength.size + 4
        val head = byteArrayOf(tableId.toByte(), (0xb0 or (len shr 8)).toByte(), len.toByte())
        return withCrc(head + payloadAfterLength)
    }

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
    private fun u16(v: Int) = bytes(v shr 8, v and 0xff)

    /** Verteilt eine Sektion auf TS-Pakete der PID */
    private fun tsPackets(pid: Int, section: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        var pos = 0
        var first = true
        var cc = 0
        while (pos < section.size || first) {
            val pkt = ByteArray(188) { 0xff.toByte() }
            pkt[0] = 0x47
            pkt[1] = ((if (first) 0x40 else 0) or (pid shr 8)).toByte()
            pkt[2] = pid.toByte()
            pkt[3] = (0x10 or (cc++ and 0x0f)).toByte()
            var p = 4
            if (first) pkt[p++] = 0 // pointer_field
            val n = minOf(188 - p, section.size - pos)
            System.arraycopy(section, pos, pkt, p, n)
            pos += n
            first = false
            out.write(pkt)
        }
        return out.toByteArray()
    }

    private fun mjd(y: Int, m: Int, d: Int): Int {
        val l = if (m == 1 || m == 2) 1 else 0
        return 14956 + d + ((y - 1900 - l) * 365.25).toInt() + ((m + 1 + l * 12) * 30.6001).toInt()
    }

    private fun bcd(v: Int) = ((v / 10) shl 4) or (v % 10)

    private fun eit(sid: Int, tsid: Int, onid: Int, eventId: Int, title: String, text: String): ByteArray {
        val t = title.toByteArray(Charsets.ISO_8859_1)
        val x = text.toByteArray(Charsets.ISO_8859_1)
        // short_event_descriptor: Sprache, Titel, Text
        val shortEv = bytes(0x4d, 3 + 1 + t.size + 1 + x.size) + "deu".toByteArray() + bytes(t.size) + t + bytes(x.size) + x
        val start = u16(mjd(2026, 10, 21)) + bytes(bcd(20), bcd(15), bcd(0))
        val dur = bytes(bcd(1), bcd(30), bcd(0))
        val event = u16(eventId) + start + dur + u16(0x8000 or shortEv.size) + shortEv
        val payload = u16(sid) + bytes(0xc1, 0, 0) + u16(tsid) + u16(onid) + bytes(0, 0x4e) + event
        return section(0x4e, payload)
    }

    // ---------- Tests ----------

    @Test
    fun crcOfValidSectionIsZero() {
        val s = section(0x00, u16(1) + bytes(0xc1, 0, 0) + u16(28) + u16(0x1000))
        assertEquals(0, Dvb.crc32(s, 0, s.size))
    }

    @Test
    fun dvbTextDecodesIso6937Umlauts() {
        // ISO 6937: Diärese (0xC8) vor dem Buchstaben, 0xFB = ß
        val b = bytes(0x4b, 0xc8, 0x6f, 0x6c, 0x6e, 0x20, 0x53, 0x74, 0x72, 0x61, 0xfb, 0x65)
        assertEquals("Köln Straße", Dvb.dvbText(b, 0, b.size))
    }

    @Test
    fun dvbTextHonoursCharsetPrefixAndLineBreaks() {
        val latin9 = bytes(0x05) + "Tagesschau".toByteArray() + bytes(0x8a) + "20 Uhr".toByteArray()
        assertEquals("Tagesschau\n20 Uhr", Dvb.dvbText(latin9, 0, latin9.size))
        val utf8 = bytes(0x15) + "Ärger über Öl".toByteArray(Charsets.UTF_8)
        assertEquals("Ärger über Öl", Dvb.dvbText(utf8, 0, utf8.size))
    }

    @Test
    fun collectorReadsPatSdtAndEitFromTsPackets() {
        val pat = section(0x00, u16(1051) + bytes(0xc1, 0, 0) + u16(28106) + u16(0xe000 or 0x100))
        val name = "Das Erste HD".toByteArray(Charsets.ISO_8859_1)
        val provider = "ARD".toByteArray(Charsets.ISO_8859_1)
        val svcDesc = bytes(0x48, 3 + provider.size + name.size, 0x19, provider.size) + provider + bytes(name.size) + name
        val sdtService = u16(28106) + bytes(0xfc) + u16(0x8000 or svcDesc.size) + svcDesc
        val sdt = section(0x42, u16(1051) + bytes(0xc1, 0, 0) + u16(61441) + bytes(0xff) + sdtService)
        val eitSec = eit(28106, 1051, 61441, 4711, "Tagesschau", "Nachrichten")

        val got = mutableListOf<Pair<String, List<EpgEvent>>>()
        val c = Dvb.MuxCollector { key, ev -> got += key to ev }
        val ts = tsPackets(0, pat) + tsPackets(17, sdt) + tsPackets(18, eitSec)
        // wie im Stream: TS-Daten paketweise (7 x 188 Byte pro RTP-Paket)
        var off = 0
        while (off < ts.size) {
            val n = minOf(7 * 188, ts.size - off)
            c.pushPayload(ts, off, n)
            off += n
        }

        assertEquals(1051, c.mux.tsid)
        assertEquals(61441, c.mux.onid)
        assertEquals(0x100, c.mux.programs[28106])
        assertEquals("Das Erste HD", c.mux.services[28106])
        assertEquals(1, got.size)
        val (key, events) = got[0]
        assertEquals("61441:1051:28106", key)
        val e = events.single()
        assertEquals("Tagesschau", e.title)
        assertEquals("Nachrichten", e.text)
        assertEquals(90 * 60000L, e.end - e.start)
        // 21.10.2026 20:15 UTC
        assertEquals(1792613700000L, e.start)
    }

    @Test
    fun corruptSectionIsIgnored() {
        val eitSec = eit(1, 2, 3, 4, "Titel", "")
        eitSec[20] = (eitSec[20].toInt() xor 0xff).toByte()
        var count = 0
        val c = Dvb.MuxCollector { _, _ -> count++ }
        val ts = tsPackets(18, eitSec)
        c.pushPayload(ts, 0, ts.size)
        assertEquals(0, count)
    }

    @Test
    fun describeTunersCountsBusyTunersFromSdp() {
        val sdp = """
            v=0
            o=- 1 1 IN IP4 192.168.177.1
            s=SatIPServer:1 0,0,4
            t=0 0
            m=video 0 RTP/AVP 33
            c=IN IP4 0.0.0.0
            a=control:stream=1
            a=fmtp:33 ver=1.2;tuner=1,240,1,7,330,,dvbc,,,,6900,34;pids=0,16
            a=sendonly
            m=video 0 RTP/AVP 33
            a=control:stream=2
            a=fmtp:33 ver=1.2;tuner=1,240,1,7,330,,dvbc,,,,6900,34;pids=0,17
            a=sendonly
            m=video 0 RTP/AVP 33
            a=control:stream=3
            a=fmtp:33 ver=1.2;tuner=3,240,1,7,450,,dvbc,,,,6900,34;pids=0
            a=sendonly
            m=video 0 RTP/AVP 33
            a=control:stream=4
            a=inactive
        """.trimIndent().replace("\n", "\r\n") + "\r\n"
        val server = ServerSocket(0)
        var request = ""
        val t = thread {
            server.accept().use { s ->
                val input = s.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                val sb = StringBuilder()
                while (true) {
                    val line = input.readLine() ?: break
                    if (line.isEmpty()) break
                    sb.append(line).append('\n')
                }
                request = sb.toString()
                val body = sdp.toByteArray(Charsets.ISO_8859_1)
                s.getOutputStream().write(
                    ("RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Type: application/sdp\r\nContent-Length: ${body.size}\r\n\r\n").toByteArray() + body
                )
            }
        }
        val status = Dvb.describeTuners("127.0.0.1", server.localPort)
        t.join(2000)
        server.close()

        assertTrue(request.startsWith("DESCRIBE rtsp://127.0.0.1:${server.localPort}/ RTSP/1.0"))
        assertEquals(4, status.total)
        assertEquals(2, status.used)   // zwei Streams teilen sich Tuner 1
        assertEquals(2, status.free)
        assertEquals(3, status.streams)
    }
}
