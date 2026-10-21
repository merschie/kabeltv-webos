package de.local.kabeltv

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.KeyEvent
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Erstes Gerüst: lädt die Senderliste der FRITZ!Box und spielt sie mit Media3 ab.
 *
 * ▲ ▼ wechseln den Sender, ☰ (Menü) schaltet zwischen "Direkt" (RTSP von der
 * FRITZ!Box) und "Proxy" (HLS vom Unraid-Proxy) um.
 */
class MainActivity : AppCompatActivity() {

    private data class Channel(val name: String, val url: String)

    private enum class Mode(val label: String) { DIRECT("Direkt"), PROXY("Proxy") }

    private lateinit var playerView: PlayerView
    private lateinit var osd: TextView
    private var player: ExoPlayer? = null

    private var channels: List<Channel> = emptyList()
    private var index = 0
    private var mode = Mode.DIRECT

    private val handler = Handler(Looper.getMainLooper())
    private val hideOsd = Runnable { osd.visibility = View.GONE }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        playerView = findViewById(R.id.player_view)
        osd = findViewById(R.id.osd)
        showOsd("Lade Senderliste …", sticky = true)
        loadChannels()
    }

    override fun onStart() {
        super.onStart()
        player = ExoPlayer.Builder(this).build().also { p ->
            p.addListener(object : Player.Listener {
                override fun onPlayerError(error: PlaybackException) {
                    showOsd("Fehler (${mode.label}): ${error.errorCodeName}\n${error.cause?.message ?: ""}", sticky = true)
                }
            })
            playerView.player = p
        }
        play()
    }

    // Tuner sofort freigeben, sobald die App in den Hintergrund geht
    override fun onStop() {
        super.onStop()
        playerView.player = null
        player?.release()
        player = null
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP -> switchChannel(1)
            KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN -> switchChannel(-1)
            KeyEvent.KEYCODE_MENU -> {
                mode = if (mode == Mode.DIRECT) Mode.PROXY else Mode.DIRECT
                play()
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> showCurrent()
            else -> return super.onKeyDown(keyCode, event)
        }
        return true
    }

    private fun loadChannels() {
        thread {
            val result = runCatching { fetchM3u("http://${BuildConfig.FRITZ_HOST}/dvb/m3u/tvhd.m3u") }
            runOnUiThread {
                result.onSuccess {
                    channels = it
                    play()
                }.onFailure {
                    showOsd("Senderliste nicht erreichbar: ${it.message}", sticky = true)
                }
            }
        }
    }

    private fun fetchM3u(address: String): List<Channel> {
        val conn = URL(address).openConnection() as HttpURLConnection
        conn.connectTimeout = 6000
        conn.readTimeout = 6000
        try {
            val out = mutableListOf<Channel>()
            var name: String? = null
            conn.inputStream.bufferedReader().forEachLine { raw ->
                val line = raw.trim()
                when {
                    line.isEmpty() -> Unit
                    line.startsWith("#EXTINF") -> name = line.substringAfter(',').trim()
                    !line.startsWith("#") -> {
                        out += Channel(name ?: line, line)
                        name = null
                    }
                }
            }
            return out
        } finally {
            conn.disconnect()
        }
    }

    private fun switchChannel(delta: Int) {
        if (channels.isEmpty()) return
        index = (index + delta).mod(channels.size)
        play()
    }

    private fun play() {
        val p = player ?: return
        val ch = channels.getOrNull(index) ?: return
        val item = when (mode) {
            Mode.DIRECT -> MediaItem.Builder()
                .setUri(ch.url)
                .setMimeType(MimeTypes.APPLICATION_RTSP)
                .build()
            Mode.PROXY -> MediaItem.Builder()
                .setUri("${BuildConfig.PROXY_URL}/hls/${b64url(ch.url)}/index.m3u8")
                .setMimeType(MimeTypes.APPLICATION_M3U8)
                .build()
        }
        p.setMediaItem(item)
        p.prepare()
        p.playWhenReady = true
        showCurrent()
    }

    private fun showCurrent() {
        val ch = channels.getOrNull(index) ?: return
        showOsd("${index + 1}  ${ch.name}\n${mode.label}")
    }

    private fun showOsd(text: String, sticky: Boolean = false) {
        osd.text = text
        osd.visibility = View.VISIBLE
        handler.removeCallbacks(hideOsd)
        if (!sticky) handler.postDelayed(hideOsd, 3000)
    }

    // Wie in der webOS-App: Base64url ohne Auffüllzeichen
    private fun b64url(s: String): String =
        Base64.encodeToString(s.toByteArray(), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
