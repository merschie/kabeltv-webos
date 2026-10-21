package de.local.kabeltv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LogosTest {

    private val index = listOf("das-erste", "zdf", "zdf-neo", "zdfinfo", "wdr", "hr", "3sat", "arte", "qvc-zwei", "rtl-zwei", "kika")
        .associateBy { it.replace("-", "") }

    private fun key(name: String) = Logos.keyFor(name, index)

    @Test
    fun matchesSimplifiedNames() {
        assertEquals("zdf", key("ZDF HD"))
        assertEquals("zdf-neo", key("ZDFneo HD"))
        assertEquals("zdfinfo", key("ZDFinfo HD"))
        assertEquals("3sat", key("3sat HD"))
        assertEquals("arte", key("arte HD"))
    }

    @Test
    fun dropsWordsFromTheEnd() {
        assertEquals("wdr", key("WDR HD Köln"))
        assertEquals("hr", key("hr-fernsehen HD"))
    }

    @Test
    fun usesAliases() {
        assertEquals("das-erste", key("Das Erste HD"))
        assertEquals("qvc-zwei", key("QVC2"))
        assertEquals("rtl-zwei", key("RTL2"))
    }

    @Test
    fun replacesUmlautsAndPlus() {
        assertEquals("kika", key("KiKA HD"))
        assertNull(key("Unbekannter Sender"))
        assertNull(key(""))
    }
}
