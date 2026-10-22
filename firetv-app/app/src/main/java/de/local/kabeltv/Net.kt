package de.local.kabeltv

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

data class Channel(val name: String, val url: String)

object Net {

    fun fetchText(address: String, timeoutMs: Int = 6000): String {
        val conn = URL(address).openConnection() as HttpURLConnection
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
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

    fun freqOf(url: String): String? = Regex("[?&]freq=([\\d.]+)").find(url)?.groupValues?.get(1)

    fun pidsOf(url: String): List<Int> =
        Regex("[?&]pids=([\\d,]+)").find(url)?.groupValues?.get(1)?.split(',')?.mapNotNull { it.toIntOrNull() } ?: emptyList()

    // Ohne avm=1: Damit behandelt die FRITZ!Box eine zweite Sitzung desselben Geräts als Senderwechsel und
    // schickt dem laufenden Sender keine Daten mehr. Ohne den Parameter laufen beide parallel.
    fun siUrl(url: String): String = url.replace(Regex("pids=[^&]*"), "pids=${Dvb.SI_PIDS}")
        .replace(Regex("([?&])avm=1(&|$)")) { if (it.groupValues[2].isNotEmpty()) it.groupValues[1] else "" }
}
