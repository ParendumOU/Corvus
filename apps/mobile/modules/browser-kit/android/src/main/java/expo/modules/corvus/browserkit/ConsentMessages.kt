package expo.modules.corvus.browserkit

import org.json.JSONObject

/**
 * What a frame's cookie banner script (consent/page.ts) sends the module. The script runs in the
 * page's own world, so every message is untrusted: only these shapes are accepted, with exactly the
 * fields expected (the events as parseConsentEvent in @corvus/shared accepts them; the app checks
 * them again), and nothing in them is ever run.
 */
sealed class ConsentMessage {
  /** A frame asks for its rules. */
  data class Init(val url: String) : ConsentMessage()

  /** What happened to a cookie banner (popupFound, optOutResult, autoconsentDone or settled). */
  data class Event(val type: String, val cmp: String? = null, val result: Boolean? = null, val isCosmetic: Boolean? = null) : ConsentMessage() {
    /** The event for the app, in parseConsentEvent's field order. */
    fun fields(): Map<String, Any> = buildMap {
      put("type", type)
      cmp?.let { put("cmp", it) }
      result?.let { put("result", it) }
      isCosmetic?.let { put("isCosmetic", it) }
    }
  }

  companion object {
    /** Longer messages are dropped unread (an init carries one address; events a short name). */
    const val MAX_LENGTH = 4096
    private const val MAX_CMP_NAME = 80
    private val CONTROL = Regex("[\\u0000-\\u001f]")

    fun parse(raw: String?): ConsentMessage? {
      if (raw == null || raw.length > MAX_LENGTH) return null
      val msg = try {
        JSONObject(raw)
      } catch (err: Exception) {
        return null
      }
      return when (msg.opt("type")) {
        "init" -> (msg.opt("url") as? String)?.takeIf { originOf(it) != null }?.let { Init(it) }
        "settled" -> Event("settled")
        "popupFound" -> cmpName(msg)?.let { Event("popupFound", it) }
        "optOutResult" -> {
          val cmp = cmpName(msg)
          val result = msg.opt("result") as? Boolean
          if (cmp != null && result != null) Event("optOutResult", cmp, result = result) else null
        }
        "autoconsentDone" -> {
          val cmp = cmpName(msg)
          val cosmetic = msg.opt("isCosmetic") as? Boolean
          if (cmp != null && cosmetic != null) Event("autoconsentDone", cmp, isCosmetic = cosmetic) else null
        }
        else -> null
      }
    }

    private fun cmpName(msg: JSONObject): String? =
      (msg.opt("cmp") as? String)?.takeIf { it.isNotEmpty() && it.length <= MAX_CMP_NAME && !CONTROL.containsMatchIn(it) }

    private val ORIGIN = Regex("^(https?)://([^/?#\\\\]*)", RegexOption.IGNORE_CASE)

    /** "scheme://host[:port]" of an http(s) address (default ports left out, lower case); null otherwise. */
    fun originOf(url: String): String? {
      val match = ORIGIN.find(url) ?: return null
      val scheme = match.groupValues[1].lowercase()
      var authority = match.groupValues[2].substringAfterLast('@').lowercase()
      authority = authority.removeSuffix(if (scheme == "https") ":443" else ":80")
      if (authority.isEmpty() || authority.startsWith(":")) return null
      return "$scheme://$authority"
    }

    /** The host of an http(s) address, as site lists store it (no "www.", no trailing dot). */
    fun siteOf(url: String): String? {
      val authority = originOf(url)?.substringAfter("://") ?: return null
      val host = if (authority.startsWith("[")) authority.substringBefore(']') + "]" else authority.substringBefore(':')
      return host.removeSuffix(".").removePrefix("www.").takeIf { it.isNotEmpty() }
    }

    /**
     * Whether the cookie banner script may run for a tab's page (shouldRunConsent): a web page whose
     * site is not one where the person keeps the banner.
     */
    fun runsOn(pageUrl: String, allowedSites: Collection<String>): Boolean {
      val site = siteOf(pageUrl) ?: return false
      return allowedSites.none { site == it || site.endsWith(".$it") }
    }
  }
}
