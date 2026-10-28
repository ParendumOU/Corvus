package expo.modules.corvus.browserkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The cases the app's own matcher passes (test/blocklist.test.ts), on the compiled rules it writes:
 * the phone blocks exactly what the TypeScript side says it does.
 */
class ContentBlockerTest {
  private fun resource(name: String): String =
    javaClass.classLoader!!.getResource("blocklist/$name")!!.readText()

  private fun rows(name: String): List<List<String>> =
    resource(name).lines().filter { it.isNotBlank() && !it.startsWith("#") }.map { it.split('\t') }

  private val rules = ContentBlocker.parse(resource("compiled.txt"))!!

  @Test
  fun readsTheCompiledRules() {
    assertEquals(16, rules.ruleCount)
    assertNull(ContentBlocker.parse("! corvus-blocklist 0\nb\tx.com\n"))
    assertNotNull(ContentBlocker.parse(ContentBlocker.HEADER))
  }

  @Test
  fun blocksWhatTheAppSays() {
    val cases = rows("cases.tsv")
    assertTrue(cases.size > 30)
    for (case in cases) {
      val (expected, url, page, main) = case
      val allowed = case.getOrNull(4).orEmpty().split(',').filter { it.isNotEmpty() }
      val blocked = rules.shouldBlock(url, if (page == "unknown") null else page, main == "true", allowed)
      assertEquals("$url on $page", expected, if (blocked) "block" else "allow")
    }
  }

  @Test
  fun hidesWhatTheAppSays() {
    for (case in rows("cosmetic.tsv")) {
      assertEquals(case[0], case.getOrNull(1).orEmpty(), rules.cosmeticSelectors(case[0]).joinToString(" | "))
    }
  }

  @Test
  fun knowsSites() {
    assertEquals(listOf("example.com", "bbc.co.uk", "example.com", "y.com.au", "host"), listOf("a.b.example.com", "news.bbc.co.uk", "example.com", "x.y.com.au", "host").map(ContentBlocker::siteOf))
    assertEquals(true, ContentBlocker.pathMatches("/tr", "/tr^"))
    assertEquals(false, ContentBlocker.pathMatches("/trending", "/tr^"))
  }
}
