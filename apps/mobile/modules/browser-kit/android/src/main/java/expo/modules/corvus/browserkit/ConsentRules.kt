package expo.modules.corvus.browserkit

import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException

/**
 * DuckDuckGo Autoconsent's compact rules (assets corvus-consent/rules.txt, packed by
 * scripts/consent-assets.mjs) and the rules one frame needs, picked the way Autoconsent's own
 * filterCompactRules does: a page gets the generic rules plus those written for its site, a frame
 * only the few that run in frames (none in most). So no page or ad frame parses the whole set, and
 * the answer for most pages is one string built once. ConsentRulesTest checks every pick against
 * filterCompactRules itself.
 */
class ConsentRules private constructor(
  private val version: String,
  private val ranges: IntArray,
  /** JSON literals. */
  private val strings: Array<String>,
  private val patterns: Array<String>,
  private val contexts: IntArray,
  private val stringIds: Array<IntArray>,
  /** JSON arrays. */
  private val rules: Array<String>,
) {
  private val genericRules = (ranges[0] until ranges[1]).toList()
  private val frameRules = ranges[2] until ranges[3]
  private val specificRules = ranges[4] until ranges[5]
  private val compiled = arrayOfNulls<Pattern>(rules.size)
  private val broken = BooleanArray(rules.size)
  private val generic: String by lazy { serialize(genericRules, ranges[6], false) }
  private val recent = object : LinkedHashMap<String, String>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > 8
  }

  val ruleCount: Int get() = rules.size

  /** The ruleset (Autoconsent's compact JSON) for a frame at `url`; null when no rule runs there. */
  @Synchronized
  fun forFrame(url: String, mainFrame: Boolean): String? {
    if (!mainFrame) {
      val picked = frameRules.filter { runs(it, false, url) }
      if (picked.isEmpty()) return null
      return recent.getOrPut("f$picked") { serialize(picked, ranges[7], true) }
    }
    val specific = specificRules.filter { runs(it, true, url) }
    if (specific.isEmpty()) return generic
    return recent.getOrPut("m$specific") { serialize(genericRules + specific, strings.size, true) }
  }

  /** Autoconsent's shouldRunRuleInContext. */
  private fun runs(rule: Int, mainFrame: Boolean, url: String): Boolean {
    val context = contexts[rule]
    if (mainFrame && context == 1) return false
    if (!mainFrame && (context == 20 || context == 22 || context == 10 || context == 12)) return false
    if (patterns[rule].isEmpty()) return true
    return pattern(rule)?.matcher(url)?.find() == true
  }

  /** Compiles the URL patterns and builds the generic answer before the first page asks (off the main thread). */
  fun prepare() {
    brokenPatterns()
    generic.length
  }

  /** Whether every URL pattern compiles here (Java's regular expressions, not JavaScript's). */
  fun brokenPatterns(): List<String> = rules.indices.filter { patterns[it].isNotEmpty() && pattern(it) == null }.map { patterns[it] }

  private fun pattern(rule: Int): Pattern? {
    if (broken[rule]) return null
    compiled[rule]?.let { return it }
    return try {
      Pattern.compile(patterns[rule]).also { compiled[rule] = it }
    } catch (err: PatternSyntaxException) {
      broken[rule] = true
      null
    }
  }

  /**
   * `{"v":…,"s":[…],"r":[…]}` for the picked rules, with the strings up to `stringEnd`; `clear`
   * blanks the strings they do not use and drops those after the last used one (clearUnusedStrings).
   */
  private fun serialize(picked: List<Int>, stringEnd: Int, clear: Boolean): String {
    val out = StringBuilder(64 * 1024)
    out.append("{\"v\":").append(version).append(",\"s\":[")
    if (clear) {
      val used = BooleanArray(strings.size)
      var last = -1
      for (rule in picked) for (id in stringIds[rule]) {
        used[id] = true
        if (id > last) last = id
      }
      for (i in 0 until minOf(stringEnd, last + 1)) {
        if (i > 0) out.append(',')
        out.append(if (used[i]) strings[i] else "\"\"")
      }
    } else {
      for (i in 0 until stringEnd) {
        if (i > 0) out.append(',')
        out.append(strings[i])
      }
    }
    out.append("],\"r\":[")
    picked.forEachIndexed { n, rule ->
      if (n > 0) out.append(',')
      out.append(rules[rule])
    }
    return out.append("]}").toString()
  }

  companion object {
    const val HEADER = "corvus-consent-rules 1"

    /** Reads rules.txt; null when it is not this format. */
    fun parse(text: String): ConsentRules? = try {
      val lines = text.split('\n')
      var at = 0
      fun next(): String = lines[at++]
      require(next() == HEADER)
      val version = next().trim().also { it.toInt() }
      val ranges = next().split(' ').map { it.toInt() }.toIntArray()
      require(ranges.size == 8)
      val strings = Array(next().toInt()) { next() }
      val count = next().toInt()
      val patterns = Array(count) { "" }
      val contexts = IntArray(count)
      val ids = Array(count) { IntArray(0) }
      val rules = Array(count) { "" }
      for (i in 0 until count) {
        patterns[i] = next()
        val (context, used, rule) = next().split('\t', limit = 3)
        contexts[i] = context.toInt()
        ids[i] = if (used.isEmpty()) IntArray(0) else used.split(',').map { it.toInt() }.toIntArray()
        require(ids[i].all { it in strings.indices } && rule.startsWith("[") && rule.endsWith("]"))
        rules[i] = rule
      }
      require(ranges.take(6).all { it in 0..count } && ranges[6] in 0..strings.size && ranges[7] in 0..strings.size)
      ConsentRules(version, ranges, strings, patterns, contexts, ids, rules)
    } catch (err: Exception) {
      null
    }
  }
}
