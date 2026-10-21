package de.local.kabeltv

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import java.io.BufferedInputStream
import java.io.IOException
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * RTSP-Minimalclient für die FRITZ!Box (SAT>IP, RTP über UDP), wie im webOS-Stream-Dienst.
 *
 * Media3-RTSP kennt keinen RTP-Payload 33 (MPEG-TS). Diese DataSource holt den Stream selbst,
 * entfernt die RTP-Header und liefert das reine MPEG-TS an den ProgressiveMediaSource/TsExtractor.
 */
@UnstableApi
class RtspTsDataSource : BaseDataSource(/* isNetwork = */ true) {

    class Factory : DataSource.Factory {
        override fun createDataSource(): DataSource = RtspTsDataSource()
    }

    private var uri: Uri? = null
    private var rtsp: Socket? = null
    private var rtspIn: BufferedInputStream? = null
    private var rtspOut: OutputStream? = null
    private var udp: DatagramSocket? = null
    private var receiver: Thread? = null
    private var keepalive: Thread? = null
    @Volatile private var running = false

    private var cseq = 0
    private var session: String? = null
    private var ctrlUrl = ""

    // TS-Daten je RTP-Paket (meist 7 × 188 Byte); rund 10 MB Puffer
    private val queue = ArrayBlockingQueue<ByteArray>(8000)
    private var chunk: ByteArray? = null
    private var chunkPos = 0

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        transferInitializing(dataSpec)
        val url = dataSpec.uri.toString()
        val host = dataSpec.uri.host ?: throw IOException("RTSP-Adresse ohne Host: $url")
        val port = dataSpec.uri.port.takeIf { it > 0 } ?: 554

        try {
            val socket = DatagramSocket(0).also { udp = it }
            runCatching { socket.receiveBufferSize = 4 * 1024 * 1024 }
            val clientPort = socket.localPort

            val s = Socket().also { rtsp = it }
            s.tcpNoDelay = true
            s.connect(InetSocketAddress(host, port), 5000)
            s.soTimeout = 5000
            rtspIn = BufferedInputStream(s.getInputStream())
            rtspOut = s.getOutputStream()

            val setup = request("SETUP", url, "Transport" to "RTP/AVP;unicast;client_port=$clientPort-${clientPort + 1}")
            if (setup.status != 200) throw IOException("RTSP SETUP: Status ${setup.status} (Tuner belegt?)")
            val sessionParts = (setup.headers["session"] ?: "").split(';')
            session = sessionParts[0].trim()
            val timeout = sessionParts.drop(1).map { it.trim() }
                .firstOrNull { it.startsWith("timeout=") }?.substringAfter('=')?.toIntOrNull() ?: 60
            ctrlUrl = setup.headers["com.ses.streamid"]?.let { "rtsp://${dataSpec.uri.authority}/stream=$it" } ?: url

            running = true
            receiver = Thread({ receive(socket) }, "rtp-empfang").apply { start() }

            val play = request("PLAY", ctrlUrl)
            if (play.status != 200) throw IOException("RTSP PLAY: Status ${play.status}")

            keepalive = Thread({
                try {
                    while (running) {
                        Thread.sleep(timeout * 500L)
                        if (running) request("OPTIONS", ctrlUrl)
                    }
                } catch (_: InterruptedException) {
                } catch (_: IOException) {
                }
            }, "rtsp-keepalive").apply { isDaemon = true; start() }
        } catch (e: IOException) {
            shutdown()
            throw e
        }

        transferStarted(dataSpec)
        return C.LENGTH_UNSET.toLong()
    }

    private fun receive(socket: DatagramSocket) {
        val buf = ByteArray(65536)
        val packet = DatagramPacket(buf, buf.size)
        try {
            while (running) {
                socket.receive(packet)
                val len = packet.length
                if (len < 12) continue
                var off = 12 + (buf[0].toInt() and 0x0f) * 4
                if (buf[0].toInt() and 0x10 != 0 && off + 4 <= len) {
                    off += 4 + (((buf[off + 2].toInt() and 0xff) shl 8) or (buf[off + 3].toInt() and 0xff)) * 4
                }
                if (off >= len) continue
                // Hängt der Player hinterher, lieber Pakete verwerfen als den Empfang zu blockieren
                if (!queue.offer(buf.copyOfRange(off, len))) queue.poll()
            }
        } catch (_: SocketException) {
            // Socket wurde beim Schließen beendet
        } catch (_: IOException) {
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        var current = chunk
        if (current == null || chunkPos >= current.size) {
            current = queue.poll(8, TimeUnit.SECONDS)
                ?: throw IOException("Keine Daten von der FRITZ!Box (RTP über UDP blockiert?)")
            chunk = current
            chunkPos = 0
        }
        val n = minOf(length, current.size - chunkPos)
        System.arraycopy(current, chunkPos, buffer, offset, n)
        chunkPos += n
        bytesTransferred(n)
        return n
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        val wasOpen = rtsp != null
        if (session != null) runCatching { request("TEARDOWN", ctrlUrl) }
        shutdown()
        uri = null
        if (wasOpen) transferEnded()
    }

    private fun shutdown() {
        running = false
        keepalive?.interrupt()
        runCatching { udp?.close() }
        runCatching { rtsp?.close() }
        receiver?.join(1000)
        keepalive = null
        receiver = null
        udp = null
        rtsp = null
        rtspIn = null
        rtspOut = null
        session = null
        queue.clear()
        chunk = null
    }

    private class Response(val status: Int, val headers: Map<String, String>)

    // Wird aus dem Ladethread und vom Keepalive aufgerufen
    @Synchronized
    private fun request(method: String, url: String, vararg extra: Pair<String, String>): Response {
        val out = rtspOut ?: throw IOException("RTSP-Verbindung geschlossen")
        val input = rtspIn ?: throw IOException("RTSP-Verbindung geschlossen")
        val msg = StringBuilder("$method $url RTSP/1.0\r\nCSeq: ${++cseq}\r\n")
        session?.let { msg.append("Session: $it\r\n") }
        for ((k, v) in extra) msg.append("$k: $v\r\n")
        msg.append("\r\n")
        out.write(msg.toString().toByteArray(Charsets.ISO_8859_1))
        out.flush()

        val statusLine = readLine(input)
        val headers = mutableMapOf<String, String>()
        while (true) {
            val line = readLine(input)
            if (line.isEmpty()) break
            val c = line.indexOf(':')
            if (c > 0) headers[line.substring(0, c).trim().lowercase()] = line.substring(c + 1).trim()
        }
        var body = headers["content-length"]?.toIntOrNull() ?: 0
        while (body > 0) {
            val skipped = input.skip(body.toLong()).toInt()
            if (skipped <= 0) break
            body -= skipped
        }
        val status = statusLine.split(' ').getOrNull(1)?.toIntOrNull()
            ?: throw IOException("RTSP $method: ungültige Antwort \"$statusLine\"")
        return Response(status, headers)
    }

    private fun readLine(input: BufferedInputStream): String {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) throw IOException("RTSP-Verbindung geschlossen")
            if (b == '\n'.code) break
            if (b != '\r'.code) sb.append(b.toChar())
        }
        return sb.toString()
    }
}
