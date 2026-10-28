package expo.modules.corvus.browserkit

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.facebook.react.uimanager.UIManagerHelper
import com.reactnativecommunity.webview.RNCWebViewHooks
import com.reactnativecommunity.webview.RNCWebViewWrapper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayInputStream
import java.io.File
import java.util.Collections
import java.util.UUID
import java.util.WeakHashMap
import java.util.concurrent.Executors

/** Every frame, of any site: the scripts check the frame's address themselves (http and https only). */
private val ALL_ORIGINS = setOf("*")
private const val PORT_PLACEHOLDER = "__CORVUS_CONSENT_PORT__"
/** Messages a page's frames may send the module per page load (a page that floods it is ignored). */
private const val MAX_CONSENT_MESSAGES = 200

private class BadRulesException : CodedException("ERR_BAD_RULES", "Not a Corvus blocklist of this version", null)

/** What a tab's WebView is showing, as the request blocker sees it. */
private class PageState {
  @Volatile var pageUrl: String? = null
  @Volatile var blocked = 0
  @Volatile var reportPending = false
  @Volatile var consentMessages = 0
  // Main thread only: the scripts added at document start in its frames.
  var gpcScript: ScriptHandler? = null
  var consentScript: ScriptHandler? = null
}

/**
 * The browser's Android side, on react-native-webview's WebView through RNCWebViewHooks (added by
 * patches/react-native-webview@14.0.1.patch):
 *
 * - blocks the requests of pages that match the ad and tracker rules (never the page itself) and
 *   counts them per tab (event onBlocked);
 * - keeps links to other apps (intent:, market:, tel:…) from opening by themselves: a tapped one is
 *   reported (onExternalLink) and opens only through openExternal once the person agrees, as a
 *   browsable activity of another app; pages never open file:, content: or top-level data: pages;
 * - denies the pages' camera and microphone requests (Corvus holds the camera for pairing, and the
 *   WebView would otherwise give it to any site silently) and reports them (onPermissionRequest);
 * - answers cookie banners with DuckDuckGo Autoconsent and sends Global Privacy Control: scripts
 *   added at document start in every frame (consent/page.ts and GPC_PAGE_SCRIPT, built into the
 *   corvus-consent assets), the banner script's rules picked here per frame (ConsentRules), and what
 *   it reports validated (ConsentMessage) before the app hears of it (onConsent);
 * - finds text in a page and reads a page's text for the app (evaluateJavascript hands the value to
 *   the app only). The one object a page could reach is the banner script's message port, which the
 *   script hides from enumeration and locks before the page's scripts run; nothing a page sends
 *   through it is run.
 */
class BrowserKitModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val pages: MutableMap<WebView, PageState> = Collections.synchronizedMap(WeakHashMap())

  @Volatile private var rules: ContentBlocker = ContentBlocker.EMPTY
  @Volatile private var enabled = true
  @Volatile private var allowedSites: Set<String> = emptySet()

  @Volatile private var consentOn = false
  @Volatile private var gpcOn = false
  @Volatile private var consentAllowedSites: Set<String> = emptySet()
  /** Picks each frame's cookie banner rules off the main thread. */
  private val consentWorker = Executors.newSingleThreadExecutor()
  @Volatile private var consentRules: ConsentRules? = null
  /** The banner script's port in the pages, named anew each start (the script removes it from window). */
  private val portName = "_" + UUID.randomUUID().toString().replace("-", "").take(20)
  private val pageScript: String? by lazy { asset("corvus-consent/page.js")?.replace(PORT_PLACEHOLDER, portName) }
  private val gpcScript: String? by lazy { asset("corvus-consent/gpc.js") }

  override fun definition() = ModuleDefinition {
    Name("CorvusBrowserKit")

    Events("onBlocked", "onExternalLink", "onPermissionRequest", "onFindResult", "onConsent")

    // The WebView's user agents: as a phone browser (the system WebView's, without the "wv" mark that
    // makes some sites, Google sign-in among them, refuse it as an app's embedded view) and as a
    // desktop browser (Chrome on Linux, for "Desktop site").
    Function("userAgents") {
      val system = WebSettings.getDefaultUserAgent(appContext.reactContext ?: throw IllegalStateException("No context"))
      val mobile = system.replace("; wv)", ")").replace(Regex(""" Version/[\d.]+"""), "")
      val chrome = Regex("""Chrome/[\d.]+""").find(mobile)?.value ?: "Chrome/140.0.0.0"
      mapOf("mobile" to mobile, "desktop" to "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) $chrome Safari/537.36")
    }

    OnCreate { install() }
    OnDestroy { uninstall() }

    // Blocking on or off, and the sites it is off for (hosts, without "www.").
    Function("configure") { on: Boolean, sites: List<String> ->
      enabled = on
      allowedSites = sites.map { it.lowercase() }.toSet()
    }

    // Cookie banners rejected (DuckDuckGo Autoconsent) and Global Privacy Control sent, each on or
    // off, and the sites whose banners are left alone (hosts, without "www."). Pages loaded from now
    // on follow them.
    Function("configurePrivacy") { consent: Boolean, gpc: Boolean, sites: List<String> ->
      consentOn = consent
      gpcOn = gpc
      consentAllowedSites = sites.map { it.lowercase() }.toSet()
      if (consent && consentRules == null) consentWorker.execute { consentRulesNow() }
      // Only WebViews on screen now: one off screen may already be destroyed (a closed tab), and
      // removing its scripts would crash the WebView. The others catch up when they come back.
      main.post { synchronized(pages) { pages.keys.toList() }.filter { it.isAttachedToWindow }.forEach { applyPrivacy(it) } }
    }

    // The compiled rules (src/lib/blocklist.ts), as text or from a file the app wrote; returns how many.
    AsyncFunction("loadRules") { text: String ->
      val parsed = ContentBlocker.parse(text) ?: throw BadRulesException()
      rules = parsed
      parsed.ruleCount
    }

    AsyncFunction("loadRulesFile") { path: String ->
      val parsed = ContentBlocker.parse(File(Uri.parse(path).path ?: path).readText()) ?: throw BadRulesException()
      rules = parsed
      parsed.ruleCount
    }

    AsyncFunction("cosmeticSelectors") { pageUrl: String ->
      if (!enabled || ContentBlocker.siteAllowed(Uri.parse(pageUrl).host.orEmpty(), allowedSites)) emptyList() else rules.cosmeticSelectors(pageUrl)
    }

    AsyncFunction("blockedCount") { viewTag: Int ->
      webView(viewTag)?.let { pages[it]?.blocked } ?: 0
    }.runOnQueue(Queues.MAIN)

    // Runs a script in the page and resolves its value, JSON-encoded (null without that page).
    AsyncFunction("evaluate") { viewTag: Int, script: String, promise: Promise ->
      val view = webView(viewTag)
      if (view == null) promise.resolve(null) else view.evaluateJavascript(script) { promise.resolve(it) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("find") { viewTag: Int, text: String ->
      val view = webView(viewTag) ?: return@AsyncFunction false
      view.setFindListener { active, total, done ->
        sendEvent("onFindResult", mapOf("viewTag" to viewTag, "active" to active, "total" to total, "done" to done))
      }
      if (text.isEmpty()) view.clearMatches() else view.findAllAsync(text)
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("findNext") { viewTag: Int, forward: Boolean ->
      webView(viewTag)?.findNext(forward)
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearFind") { viewTag: Int ->
      webView(viewTag)?.let {
        it.clearMatches()
        it.setFindListener(null)
      }
      true
    }.runOnQueue(Queues.MAIN)

    // Forgets what sites stored on the phone: cookies (signed-in sessions too), site storage and the
    // cache. Resolves once the cookies are gone.
    AsyncFunction("clearBrowsingData") { promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.resolve(false)
      WebStorage.getInstance().deleteAllData()
      WebView(context).apply {
        clearCache(true)
        destroy()
      }
      CookieManager.getInstance().removeAllCookies { CookieManager.getInstance().flush(); promise.resolve(true) }
    }.runOnQueue(Queues.MAIN)

    // Opens a link to another app the person agreed to open. Resolves "opened", "web:<address>" (a
    // web page to load in the tab instead: the link's own fallback, or a web address it carried) or
    // "none" (no app on the phone opens it).
    AsyncFunction("openExternal") { url: String ->
      openExternal(url)
    }.runOnQueue(Queues.MAIN)
  }

  private fun webView(viewTag: Int): WebView? {
    val context = appContext.reactContext ?: return null
    val view = try {
      UIManagerHelper.getUIManagerForReactTag(context as com.facebook.react.bridge.ReactContext, viewTag)?.resolveView(viewTag)
    } catch (err: Exception) {
      null
    }
    return (view as? RNCWebViewWrapper)?.webView ?: view as? WebView
  }

  private fun tagOf(view: WebView): Int = (view.parent as? View)?.id ?: -1

  private fun stateOf(view: WebView): PageState = synchronized(pages) { pages.getOrPut(view) { PageState() } }

  /** Tells the app a tab's count, at most every 300 ms. */
  private fun report(view: WebView, state: PageState) {
    if (state.reportPending) return
    state.reportPending = true
    main.postDelayed({
      state.reportPending = false
      val tag = tagOf(view)
      if (tag != -1) sendEvent("onBlocked", mapOf("viewTag" to tag, "count" to state.blocked, "pageUrl" to state.pageUrl))
    }, 300)
  }

  private fun install() {
    RNCWebViewHooks.viewConfigurer = RNCWebViewHooks.ViewConfigurer { view ->
      // Google Safe Browsing (on by default; said explicitly), and no X-Requested-With header naming
      // Corvus to every site (sites would tell the app apart, and some refuse embedded browsers).
      if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) WebSettingsCompat.setSafeBrowsingEnabled(view.settings, true)
      if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) WebSettingsCompat.setRequestedWithHeaderOriginAllowList(view.settings, emptySet())
      applyPrivacy(view)
      // A tab's WebView leaves the window while another screen is on top (Settings among them).
      view.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(attached: View) = applyPrivacy(view)
        override fun onViewDetachedFromWindow(detached: View) = Unit
      })
    }

    RNCWebViewHooks.requestInterceptor = RNCWebViewHooks.RequestInterceptor { view, request ->
      val url = request.url.toString()
      val state = stateOf(view)
      if (request.isForMainFrame) {
        state.pageUrl = url
        state.blocked = 0
        state.consentMessages = 0
        report(view, state)
        return@RequestInterceptor null
      }
      if (!enabled || !rules.shouldBlock(url, state.pageUrl, false, allowedSites)) return@RequestInterceptor null
      state.blocked++
      report(view, state)
      // An empty answer: the ad's script, image or frame gets nothing (and no error page).
      WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
    }

    RNCWebViewHooks.navigationHandler = RNCWebViewHooks.NavigationHandler { view, request ->
      when (request.url.scheme?.lowercase()) {
        null, "http", "https", "about", "blob", "javascript" -> false
        // A page may not open a data: document in the tab (a phishing trick); frames keep them.
        "data" -> request.isForMainFrame
        "file", "content" -> true
        else -> {
          // Another app's link: never opened by itself. One the person tapped (or a page's redirect
          // after a tap) is offered to them; one a page opens on its own is dropped.
          if (request.isForMainFrame && (request.hasGesture() || request.isRedirect)) {
            sendEvent("onExternalLink", mapOf("viewTag" to tagOf(view), "url" to request.url.toString()))
          }
          true
        }
      }
    }

    RNCWebViewHooks.permissionHandler = RNCWebViewHooks.PermissionHandler { view, request ->
      val kinds = request.resources.map {
        when (it) {
          PermissionRequest.RESOURCE_VIDEO_CAPTURE -> "camera"
          PermissionRequest.RESOURCE_AUDIO_CAPTURE -> "microphone"
          PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID -> "protected-media"
          PermissionRequest.RESOURCE_MIDI_SYSEX -> "midi"
          else -> it
        }
      }
      request.deny()
      sendEvent("onPermissionRequest", mapOf("viewTag" to tagOf(view), "origin" to request.origin.toString(), "kinds" to kinds))
      true
    }
  }

  private fun asset(name: String): String? = try {
    appContext.reactContext?.assets?.open(name)?.use { it.readBytes().toString(Charsets.UTF_8) }
  } catch (err: Exception) {
    null
  }

  /** Adds or removes a WebView's document-start scripts (and the banner script's port) as the settings say. Main thread. */
  private fun applyPrivacy(view: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    val state = stateOf(view)
    val gpc = if (gpcOn) gpcScript else null
    if (gpc != null && state.gpcScript == null) state.gpcScript = WebViewCompat.addDocumentStartJavaScript(view, gpc, ALL_ORIGINS)
    if (gpc == null && state.gpcScript != null) {
      state.gpcScript?.remove()
      state.gpcScript = null
    }
    val consent = if (consentOn && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) pageScript else null
    if (consent != null && state.consentScript == null) {
      WebViewCompat.addWebMessageListener(view, portName, ALL_ORIGINS) { source, message, origin, mainFrame, reply ->
        onConsentMessage(source, message.data, origin.toString(), mainFrame, reply)
      }
      state.consentScript = WebViewCompat.addDocumentStartJavaScript(view, consent, ALL_ORIGINS)
    }
    if (consent == null && state.consentScript != null) {
      state.consentScript?.remove()
      state.consentScript = null
      WebViewCompat.removeWebMessageListener(view, portName)
    }
  }

  /**
   * A message from a frame's cookie banner script (main thread). An init gets the frame's rules, when
   * the tab's page is one the banner script works on; an event goes to the app. Anything else, and
   * anything past a page's share of messages, is dropped.
   */
  private fun onConsentMessage(view: WebView, data: String?, origin: String, mainFrame: Boolean, reply: JavaScriptReplyProxy) {
    val state = stateOf(view)
    if (!consentOn || state.consentMessages >= MAX_CONSENT_MESSAGES) return
    state.consentMessages++
    when (val message = ConsentMessage.parse(data)) {
      is ConsentMessage.Init -> {
        // The address it gives must be its own; a frame's page is the tab's.
        if (ConsentMessage.originOf(message.url) != ConsentMessage.originOf(origin)) return
        val pageUrl = if (mainFrame) message.url else view.url ?: return
        if (!ConsentMessage.runsOn(pageUrl, consentAllowedSites)) return
        // Once the rules are read, picking a frame's is quick (its answer is mostly built already):
        // answered at once, without a second wait for this thread. Before that, the worker reads them.
        val rules = consentRules
        if (rules != null) {
          rules.forFrame(message.url, mainFrame)?.let { answerFrame(reply, it) }
          return
        }
        consentWorker.execute {
          val subset = consentRulesNow()?.forFrame(message.url, mainFrame) ?: return@execute
          main.post { answerFrame(reply, subset) }
        }
      }
      is ConsentMessage.Event -> {
        val tag = tagOf(view)
        if (message.type == "settled" || tag == -1) return
        sendEvent("onConsent", message.fields() + mapOf("viewTag" to tag, "mainFrame" to mainFrame))
      }
      null -> Unit
    }
  }

  private fun answerFrame(reply: JavaScriptReplyProxy, subset: String) {
    try {
      reply.postMessage("{\"type\":\"rules\",\"rules\":$subset}")
    } catch (err: Exception) {
      // The frame is gone.
    }
  }

  /** The rules, read from the assets on the worker (when the feature is turned on, or by the first frame). */
  private fun consentRulesNow(): ConsentRules? {
    consentRules?.let { return it }
    return asset("corvus-consent/rules.txt")?.let { ConsentRules.parse(it) }?.also {
      it.prepare()
      consentRules = it
    }
  }

  private fun uninstall() {
    RNCWebViewHooks.viewConfigurer = null
    RNCWebViewHooks.requestInterceptor = null
    RNCWebViewHooks.navigationHandler = null
    RNCWebViewHooks.permissionHandler = null
  }

  private fun openExternal(url: String): String {
    val intent = try {
      if (url.startsWith("intent:", ignoreCase = true)) Intent.parseUri(url, Intent.URI_INTENT_SCHEME) else Intent(Intent.ACTION_VIEW, Uri.parse(url))
    } catch (err: Exception) {
      return "none"
    }
    val fallback = intent.getStringExtra("browser_fallback_url")?.takeIf { isWeb(it) }
    // A link that is a web page after all opens in the tab, not through the system (which could
    // hand it straight back to Corvus).
    intent.data?.toString()?.takeIf { isWeb(it) }?.let { return "web:$it" }
    // Only another app's activity that links may open (no component a page names, no selector, no
    // access to Corvus's own files), and never Corvus itself.
    intent.addCategory(Intent.CATEGORY_BROWSABLE)
    intent.component = null
    intent.selector = null
    intent.flags = intent.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
      Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION).inv()
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val context = appContext.reactContext ?: return "none"
    if (intent.`package` == context.packageName) return fallback?.let { "web:$it" } ?: "none"
    val resolved = context.packageManager.resolveActivity(intent, 0)?.activityInfo?.packageName
    if (resolved == context.packageName) return fallback?.let { "web:$it" } ?: "none"
    return try {
      (appContext.currentActivity ?: context).startActivity(intent)
      "opened"
    } catch (err: ActivityNotFoundException) {
      fallback?.let { "web:$it" } ?: "none"
    } catch (err: SecurityException) {
      fallback?.let { "web:$it" } ?: "none"
    }
  }

  private fun isWeb(url: String): Boolean = url.startsWith("https://", ignoreCase = true) || url.startsWith("http://", ignoreCase = true)
}
