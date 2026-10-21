package de.local.kabeltv

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory

/**
 * Senderlogos aus webos-app/logos (beim Bauen nach assets/logos kopiert), Zuordnung wie in der webOS-App:
 * Der Sendername wird vereinfacht ("ZDFneo HD" -> "zdfneo") und mit den Schlüsseln ohne Bindestriche verglichen.
 * Passt nichts, werden hinten Wörter weggelassen ("WDR HD Köln" -> "wdr", "hr-fernsehen" -> "hr").
 */
class Logos(private val context: Context) {

    private val index: Map<String, String> by lazy {
        (runCatching { context.assets.list("logos") }.getOrNull() ?: emptyArray())
            .filter { it.endsWith(".png") }
            .map { it.removeSuffix(".png") }
            .associateBy { it.replace("-", "") }
    }

    private val cache = HashMap<String, Bitmap?>()

    fun keyFor(name: String): String? = keyFor(name, index)

    companion object {
        private val alias = mapOf(
            "erste" to "das-erste", "ardhd" to "das-erste",
            "pro7" to "pro-sieben", "pro7maxx" to "pro-sieben-maxx",
            "rtl2" to "rtl-zwei", "rtlnitro" to "nitro", "superrtl" to "rtl-super", "rtlsuper" to "rtl-super",
            "kabel1" to "kabel-eins", "kabel1doku" to "kabel-eins-doku", "kabel1classics" to "kabel-eins-classics",
            "servustv" to "servus-tv-deutchland", "servustvdeutschland" to "servus-tv-deutchland",
            "euronews" to "euronews-deutsch", "eurosport" to "eurosport-1", "hse24" to "hse", "qvc2" to "qvc-zwei",
            "ndrfshh" to "ndr-hamburg", "ndrfsmv" to "ndr-mecklenburg-vorpommern", "ndrfssh" to "ndr-schleswig-holstein",
            "mdrsachsenanhalt" to "mdr-sachsen-anhalt", "mdrthuringen" to "mdr-thuringen",
            "welttv" to "welt", "ntvhd" to "ntv", "dmf" to "deutsches-musik-fernsehen"
        )

        /** [index]: Logo-Schlüssel ohne Bindestriche -> Dateiname ohne .png */
        fun keyFor(name: String, index: Map<String, String>): String? {
            val words = name.lowercase()
                .replace("ä", "a").replace("ö", "o").replace("ü", "u").replace("ß", "ss")
                .replace("+", " plus ")
                .split(Regex("[^a-z0-9]+"))
                .filter { it.isNotEmpty() && !Regex("^(hd|sd|uhd|4k)$").matches(it) }
            for (n in words.size downTo 1) {
                val c = words.take(n).joinToString("")
                alias[c]?.let { return it }
                index[c]?.let { return it }
            }
            return null
        }
    }

    fun bitmapFor(name: String): Bitmap? {
        val key = keyFor(name) ?: return null
        return cache.getOrPut(key) {
            runCatching { context.assets.open("logos/$key.png").use { BitmapFactory.decodeStream(it) } }.getOrNull()
        }
    }
}
