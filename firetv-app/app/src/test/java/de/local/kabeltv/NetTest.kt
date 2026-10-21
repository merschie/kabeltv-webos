package de.local.kabeltv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NetTest {

    private val m3u = """
        #EXTM3U
        #EXTINF:0,Das Erste HD
        #EXTVLCOPT:network-caching=1000
        rtsp://192.168.177.1:554/?avm=1&freq=330&bw=8&msys=dvbc&mtype=256qam&sr=6900&specinv=0&pids=0,16,17,18,20,5100,5101,5102
        #EXTINF:0,ZDF HD
        rtsp://192.168.177.1:554/?avm=1&freq=450&bw=8&msys=dvbc&mtype=256qam&sr=6900&specinv=0&pids=0,16,17,18,20,6100,6110
        rtsp://192.168.177.1:554/?freq=114&pids=0,1
    """.trimIndent()

    @Test
    fun parseM3uReadsNamesAndUrls() {
        val list = Net.parseM3u(m3u)
        assertEquals(3, list.size)
        assertEquals("Das Erste HD", list[0].name)
        assertEquals("ZDF HD", list[1].name)
        // ohne #EXTINF dient die Adresse als Name
        assertEquals(list[2].url, list[2].name)
    }

    @Test
    fun parseM3uHandlesWindowsLineEndings() {
        val list = Net.parseM3u("#EXTM3U\r\n#EXTINF:0,arte HD\r\nrtsp://h/?freq=1\r\n")
        assertEquals(listOf(Channel("arte HD", "rtsp://h/?freq=1")), list)
    }

    @Test
    fun freqAndPids() {
        val url = Net.parseM3u(m3u)[0].url
        assertEquals("330", Net.freqOf(url))
        assertEquals(listOf(0, 16, 17, 18, 20, 5100, 5101, 5102), Net.pidsOf(url))
        assertNull(Net.freqOf("rtsp://h/?pids=0"))
    }

    @Test
    fun siUrlKeepsTuningButOnlyRequestsSiPids() {
        val url = Net.parseM3u(m3u)[0].url
        assertEquals(
            "rtsp://192.168.177.1:554/?avm=1&freq=330&bw=8&msys=dvbc&mtype=256qam&sr=6900&specinv=0&pids=0,17,18",
            Net.siUrl(url)
        )
    }
}
