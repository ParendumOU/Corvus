package expo.modules.corvus.browserkit

/**
 * The ad and tracker rules a page's requests are matched against: hosts blocked for everyone,
 * hosts blocked on other sites' pages, exceptions, path prefixes per host and the elements hidden
 * per site. Built from the compiled file the app writes (src/lib/blocklist.ts, serializeRules);
 * matches exactly as that file's matchRequest and cosmeticSelectors (ContentBlockerTest runs the
 * same cases). Immutable, so requests on any thread can read it.
 */
class ContentBlocker private constructor(
  private val block: Set<String>,
  private val thirdParty: Set<String>,
  private val allow: Set<String>,
  private val paths: Map<String, List<String>>,
  private val cosmetic: Map<String, List<String>>,
) {
  val ruleCount: Int = block.size + thirdParty.size + allow.size + paths.values.sumOf { it.size } + cosmetic.values.sumOf { it.size }

  /** Whether a request a page makes is blocked; `pageUrl` is its top frame's address (null when unknown). */
  fun shouldBlock(url: String, pageUrl: String?, mainFrame: Boolean, allowedSites: Collection<String>): Boolean {
    if (mainFrame) return false
    val req = parts(url) ?: return false
    if (!req.web || req.host.isEmpty() || isLoopback(req.host)) return false
    val page = pageUrl?.let { parts(it) }
    if (page != null && siteAllowed(page.host, allowedSites)) return false
    val suffixes = hostSuffixes(req.host)
    if (suffixes.any { it in allow }) return false
    if (suffixes.any { it in block }) return true
    if (page != null && page.host.isNotEmpty() && siteOf(page.host) != siteOf(req.host) && suffixes.any { it in thirdParty }) return true
    for (h in suffixes) {
      val prefixes = paths[h] ?: continue
      if (prefixes.any { pathMatches(req.path, it) }) return true
    }
    return false
  }

  /** The CSS selectors hidden on a page: its host's and every parent domain's. */
  fun cosmeticSelectors(pageUrl: String): List<String> {
    val page = parts(pageUrl) ?: return emptyList()
    if (!page.web) return emptyList()
    val out = LinkedHashSet<String>()
    for (h in hostSuffixes(page.host)) cosmetic[h]?.let { out.addAll(it) }
    return out.toList()
  }

  private class Parts(val host: String, val path: String, val web: Boolean)

  companion object {
    const val HEADER = "! corvus-blocklist 1"

    val EMPTY = ContentBlocker(emptySet(), emptySet(), emptySet(), emptyMap(), emptyMap())

    private val URL_RE = Regex("""^([a-z][a-z0-9+.-]*)://(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)(?::\d+)?([^?#]*)""", RegexOption.IGNORE_CASE)
    private val SECOND_LEVEL = setOf("co", "com", "net", "org", "gov", "edu", "ac", "gob", "or", "ne", "go", "mil", "nom", "ltd", "plc", "gv")
    private val SEPARATOR_FREE = Regex("[A-Za-z0-9_.%-]")

    /** Reads the compiled rules; null when the file is of another format version. */
    fun parse(text: String): ContentBlocker? {
      val lines = text.lineSequence().iterator()
      if (!lines.hasNext() || lines.next() != HEADER) return null
      val block = HashSet<String>()
      val thirdParty = HashSet<String>()
      val allow = HashSet<String>()
      val paths = HashMap<String, MutableList<String>>()
      val cosmetic = HashMap<String, MutableList<String>>()
      for (line in lines) {
        val fields = line.split('\t')
        val a = fields.getOrNull(1)
        if (a.isNullOrEmpty()) continue
        val b = fields.getOrNull(2)
        when (fields[0]) {
          "b" -> block.add(a)
          "t" -> thirdParty.add(a)
          "a" -> allow.add(a)
          "p" -> if (!b.isNullOrEmpty()) paths.getOrPut(a) { ArrayList(1) }.let { if (b !in it) it.add(b) }
          "c" -> if (!b.isNullOrEmpty()) cosmetic.getOrPut(a) { ArrayList(2) }.let { if (b !in it) it.add(b) }
        }
      }
      return ContentBlocker(block, thirdParty, allow, paths, cosmetic)
    }

    private fun parts(url: String): Parts? {
      val m = URL_RE.find(url) ?: return null
      val scheme = m.groupValues[1].lowercase()
      val host = m.groupValues[2].lowercase().removeSuffix(".")
      val path = m.groupValues[3].ifEmpty { "/" }
      return Parts(host, path, scheme == "http" || scheme == "https")
    }

    /** The host and every parent domain of it with a dot. */
    fun hostSuffixes(host: String): List<String> {
      val out = ArrayList<String>(4)
      var h = host
      while (h.contains('.')) {
        out.add(h)
        h = h.substring(h.indexOf('.') + 1)
      }
      return out
    }

    /** A host's site (registrable domain), close enough for third-party checks. */
    fun siteOf(host: String): String {
      val labels = host.split('.')
      if (labels.size <= 2) return host
      val take = if (labels[labels.size - 1].length == 2 && labels[labels.size - 2] in SECOND_LEVEL) 3 else 2
      return labels.takeLast(take).joinToString(".")
    }

    fun siteAllowed(pageHost: String, allowedSites: Collection<String>): Boolean {
      val host = pageHost.lowercase().removePrefix("www.")
      return allowedSites.any { host == it || host.endsWith(".$it") }
    }

    private fun isLoopback(host: String): Boolean =
      host == "localhost" || host.endsWith(".localhost") || host.startsWith("127.") || host == "[::1]"

    /** A path prefix; one ending with "^" matches a path that stops there or goes on with a separator. */
    fun pathMatches(path: String, prefix: String): Boolean {
      if (!prefix.endsWith('^')) return path.startsWith(prefix)
      val base = prefix.dropLast(1)
      return path.startsWith(base) && (path.length == base.length || !SEPARATOR_FREE.matches(path[base.length].toString()))
    }
  }
}
