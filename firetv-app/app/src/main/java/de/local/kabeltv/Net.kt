package de.local.kabeltv

import android.util.Base64
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

data class Channel(val name: String, val url: String)

object Net {

    fun fetchText(address: String, timeoutMs: Int = 6000, method: String = "GET"): String {
        val conn = URL(address).openConnection() as HttpURLConnection
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.requestMethod = method
        conn.useCaches = false
        try {
            if (conn.responseCode != 200) throw IOException("HTTP ${conn.responseCode}")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    fun parseM3u(text: String): List<Channel> {
        val out = mutableListOf<Channel>()
        var name: String? = null
        for (raw in text.lines()) {
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
    }

    // Wie in der webOS-App: Base64url ohne Auffüllzeichen
    fun b64url(s: String): String =
        Base64.encodeToString(s.toByteArray(), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    fun freqOf(url: String): String? = Regex("[?&]freq=([\\d.]+)").find(url)?.groupValues?.get(1)

    fun pidsOf(url: String): List<Int> =
        Regex("[?&]pids=([\\d,]+)").find(url)?.groupValues?.get(1)?.split(',')?.mapNotNull { it.toIntOrNull() } ?: emptyList()

    fun siUrl(url: String): String = url.replace(Regex("pids=[^&]*"), "pids=${Dvb.SI_PIDS}")
}
