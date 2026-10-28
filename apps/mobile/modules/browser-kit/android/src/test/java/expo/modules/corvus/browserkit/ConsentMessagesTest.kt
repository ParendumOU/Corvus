package expo.modules.corvus.browserkit

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The module accepts from a page's cookie banner script exactly what the app does
 * (parseConsentEvent, test/cookie-consent.test.ts checks the same cases), and checks the frames'
 * addresses and the sites that keep their banner.
 */
class ConsentMessagesTest {
  private fun rows(): List<List<String>> =
    javaClass.classLoader!!.getResource("consent/messages.tsv")!!.readText().lines()
      .filter { it.isNotBlank() && !it.startsWith("#") }.map { it.split('\t') }

  // In parseConsentEvent's field order, as JSON.stringify writes it.
  private fun ConsentMessage.Event.toJson(): String =
    fields().entries.joinToString(",", "{", "}") { (k, v) -> JSONObject.quote(k) + ":" + if (v is String) JSONObject.quote(v) else v.toString() }

  @Test
  fun acceptsWhatTheAppAccepts() {
    val cases = rows()
    assertTrue(cases.size > 25)
    for ((raw, expected) in cases) {
      val event = ConsentMessage.parse(raw) as? ConsentMessage.Event
      assertEquals(raw, expected, event?.toJson() ?: "null")
    }
  }

  @Test
  fun readsAFramesInit() {
    assertEquals(ConsentMessage.Init("https://example.com/a?b"), ConsentMessage.parse("""{"type":"init","url":"https://example.com/a?b"}"""))
    assertNull(ConsentMessage.parse("""{"type":"init","url":"javascript:alert(1)"}"""))
    assertNull(ConsentMessage.parse("""{"type":"init","url":"about:blank"}"""))
    assertNull(ConsentMessage.parse("""{"type":"init","url":42}"""))
    assertNull(ConsentMessage.parse("""{"type":"init"}"""))
    assertNull(ConsentMessage.parse("not json"))
    assertNull(ConsentMessage.parse(null))
    assertNull(ConsentMessage.parse("""{"type":"init","url":"https://example.com/${"a".repeat(ConsentMessage.MAX_LENGTH)}"}"""))
  }

  @Test
  fun comparesOrigins() {
    assertEquals("https://example.com", ConsentMessage.originOf("https://Example.com:443/path?q#h"))
    assertEquals("http://10.0.2.2:18766", ConsentMessage.originOf("http://10.0.2.2:18766/onetrust"))
    assertEquals("http://example.com", ConsentMessage.originOf("http://user:pw@example.com:80"))
    assertEquals("https://[::1]:8443", ConsentMessage.originOf("https://[::1]:8443/"))
    assertEquals("https://example.com:8443", ConsentMessage.originOf("https://example.com:8443"))
    assertNull(ConsentMessage.originOf("null"))
    assertNull(ConsentMessage.originOf("file:///sdcard/a.html"))
    assertNull(ConsentMessage.originOf("https:///path"))
  }

  @Test
  fun leavesTheSitesThatKeepTheirBanner() {
    val allowed = listOf("example.com", "news.org")
    assertFalse(ConsentMessage.runsOn("https://www.example.com/a", allowed))
    assertFalse(ConsentMessage.runsOn("https://shop.example.com./", allowed))
    assertFalse(ConsentMessage.runsOn("http://NEWS.org:8080/", allowed))
    assertTrue(ConsentMessage.runsOn("https://example.org/", allowed))
    assertTrue(ConsentMessage.runsOn("https://notexample.com/", allowed))
    assertTrue(ConsentMessage.runsOn("http://10.0.2.2:18766/onetrust", allowed))
    assertFalse(ConsentMessage.runsOn("http://10.0.2.2:18766/onetrust", listOf("10.0.2.2")))
    assertFalse(ConsentMessage.runsOn("about:blank", emptyList()))
    assertFalse(ConsentMessage.runsOn("data:text/html,x", emptyList()))
  }
}
