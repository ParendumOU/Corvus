package expo.modules.corvus.browserkit

import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rules each frame gets are exactly what Autoconsent's filterCompactRules gives (cases.tsv,
 * written from it by scripts/consent-assets.mjs for many pages and frames: generic pages, the sites
 * of the site-specific rules, consent frames), byte for byte.
 */
class ConsentRulesTest {
  private fun resource(name: String): String =
    javaClass.classLoader!!.getResource("corvus-consent/$name")!!.readText()

  private val rules = ConsentRules.parse(resource("rules.txt"))!!

  private fun sha256(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

  @Test
  fun readsThePackedRules() {
    assertTrue(rules.ruleCount > 500)
    assertNull(ConsentRules.parse("corvus-consent-rules 0\n1\n"))
    // A rule that uses a string the file does not have.
    assertNull(ConsentRules.parse(ConsentRules.HEADER + "\n1\n0 1 0 1 1 1 0 0\n0\n1\n\n1\t5\t[]\n"))
    assertNotNull(ConsentRules.parse(ConsentRules.HEADER + "\n1\n0 1 0 1 1 1 0 0\n0\n1\n\n1\t\t[]\n"))
    assertNotNull(ConsentRules.parse(ConsentRules.HEADER + "\n1\n0 0 0 0 0 0 0 0\n0\n0\n"))
  }

  @Test
  fun everyUrlPatternCompiles() {
    assertEquals(emptyList<String>(), rules.brokenPatterns())
  }

  @Test
  fun picksWhatAutoconsentPicks() {
    val cases = resource("cases.tsv").lines().filter { it.isNotBlank() }.map { it.split('\t') }
    assertTrue(cases.size > 500)
    val generic = cases.first { it[1] == "https://example.com/" }[2].toInt()
    var specific = 0
    for ((frame, url, count, hash) in cases) {
      val mainFrame = frame == "main"
      val subset = rules.forFrame(url, mainFrame)
      assertEquals("$frame $url", hash, subset?.let { sha256(it) } ?: "none")
      if (mainFrame && count.toInt() > generic) specific++
    }
    // Many pages got rules written for their site on top of the generic ones.
    assertTrue(specific > 100)
  }
}
