package de.local.kabeltv

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import java.io.IOException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Media3-RTSP kennt keinen RTP-Payload 33 (MPEG-TS). Diese DataSource holt den Stream über [RtspSession]
 * selbst und liefert das reine MPEG-TS an ProgressiveMediaSource/TsExtractor, wie der webOS-Stream-Dienst.
 */
@UnstableApi
class RtspTsDataSource(private val hooks: Hooks) : BaseDataSource(/* isNetwork = */ true) {

    /** Rückmeldungen an die App; alle Aufrufe kommen von Hintergrundthreads. */
    interface Hooks {
        /** SETUP abgelehnt (Tuner belegt). true = es wurde ein Tuner frei gemacht, nochmal versuchen. */
        fun onTunerBusy(): Boolean = false
        fun onConnected(url: String) {}
        fun onFirstData(url: String) {}
        /** Mitlesen der SI-Daten für den EPG */
        fun sniffer(url: String): Sniffer? = null
    }

    interface Sniffer {
        fun push(buf: ByteArray, off: Int, len: Int)
        fun finish()
    }

    class Factory(private val hooks: Hooks) : DataSource.Factory {
        override fun createDataSource(): DataSource = RtspTsDataSource(hooks)
    }

    private var uri: Uri? = null
    private var session: RtspSession? = null
    private var sniffer: Sniffer? = null
    @Volatile private var gotData = false

    // TS-Daten je RTP-Paket (meist 7 × 188 Byte); rund 10 MB Puffer
    private val queue = ArrayBlockingQueue<ByteArray>(8000)
    private var chunk: ByteArray? = null
    private var chunkPos = 0

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        transferInitializing(dataSpec)
        val url = dataSpec.uri.toString()
        val sniff = hooks.sniffer(url)
        sniffer = sniff
        gotData = false

        val onPayload = { buf: ByteArray, off: Int, len: Int ->
            sniff?.push(buf, off, len)
            if (!gotData) {
                gotData = true
                hooks.onFirstData(url)
            }
            // Hängt der Player hinterher, lieber Pakete verwerfen als den Empfang zu blockieren
            if (!queue.offer(buf.copyOfRange(off, off + len))) queue.poll()
        }

        var s = RtspSession(url, onPayload)
        try {
            s.open()
        } catch (e: RtspStatusException) {
            if (e.method != "SETUP" || !hooks.onTunerBusy()) throw e
            s = RtspSession(url, onPayload)
            s.open()
        }
        session = s
        hooks.onConnected(url)

        transferStarted(dataSpec)
        return C.LENGTH_UNSET.toLong()
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
        val s = session
        session = null
        s?.close()
        sniffer?.finish()
        sniffer = null
        queue.clear()
        chunk = null
        uri = null
        if (s != null) transferEnded()
    }
}
