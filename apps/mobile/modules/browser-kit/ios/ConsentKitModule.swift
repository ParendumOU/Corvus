import ExpoModulesCore
import WebKit

/// Corvus's iOS browser answers cookie banners (DuckDuckGo Autoconsent) here, on top of
/// react-native-webview's WKWebView: the same JavaScript interface as the Android module's
/// configurePrivacy and onConsent (see modules/browser-kit/index.ts, `ConsentKit`). Global Privacy
/// Control on iOS is the app's document-start script (web-page.tsx), not this module's.
public final class ConsentKitModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CorvusConsentKit")

    Events("onConsent")

    OnCreate {
      ConsentKit.shared.start { [weak self] body in
        self?.sendEvent("onConsent", body)
      }
    }

    // Cookie banners rejected or not, and the sites that keep their banner. The GPC switch is
    // accepted for the same signature as Android's and handled by the app.
    Function("configurePrivacy") { (consent: Bool, _: Bool, sites: [String]) in
      DispatchQueue.main.async {
        ConsentKit.shared.configure(enabled: consent, allowedSites: sites.map { $0.lowercased() })
      }
    }

    // Settings, Browser, "Clear cookies and site data": every site's cookies, storage and cache in
    // the data store react-native-webview's WebViews use (the default one), as Android's module does.
    AsyncFunction("clearBrowsingData") { (promise: Promise) in
      DispatchQueue.main.async {
        WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
          promise.resolve(true)
        }
      }
    }
  }
}

/// The cookie banner script and its link to the app:
///
/// - react-native-webview (patched, patches/react-native-webview@14.0.1.patch) posts
///   `RNCWebViewScriptsReset` each time it sets up a WebView's user scripts again (it removes them
///   all first). The script (consent/page-ios.ts, bundled) is added then, at document start in every
///   frame, in the content world `corvus-consent`: the page's scripts share the DOM with it, never
///   its globals. Its message handler is registered in that world only, so pages cannot post to it.
/// - A frame asks for its rules (`init`, with its address, which must be of the frame's own origin
///   as WebKit reports it) and gets the ones that can apply there (ConsentRules), or nothing.
/// - A snippet asked for by id (`eval`) runs in the frame's page world only if it is one of
///   Autoconsent's bundled snippets (snippets.json); a message never carries code.
/// - Events (ConsentMessage) go to the app as onConsent, at most `maxMessages` per page load.
final class ConsentKit: NSObject {
  static let shared = ConsentKit()
  static let handlerName = "corvusConsent"
  static let resetNotification = Notification.Name("RNCWebViewScriptsReset")
  static let maxMessages = 200
  private static let world = WKContentWorld.world(name: "corvus-consent")

  private var emit: (([String: Any]) -> Void)?
  private var observing = false
  private var enabled = false
  private var allowedSites: [String] = []
  /// The react-native-webview views whose scripts were set up (to set them up again on a change).
  private let owners = NSHashTable<UIView>.weakObjects()
  private lazy var script: WKUserScript? = asset("page", "js").map {
    WKUserScript(source: $0, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: Self.world)
  }
  private lazy var snippets: [String: String] = {
    guard let text = asset("snippets", "json"), let data = text.data(using: .utf8),
          let map = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] else { return [:] }
    return map.filter { ConsentMessage.isSnippetId($0.key) }
  }()
  private let worker = DispatchQueue(label: "corvus.consent", qos: .userInitiated)
  /// Read on the worker only.
  private var rules: ConsentRules?

  func start(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
    guard !observing else { return }
    observing = true
    NotificationCenter.default.addObserver(self, selector: #selector(scriptsReset(_:)), name: Self.resetNotification, object: nil)
  }

  /// On the main thread.
  func configure(enabled: Bool, allowedSites: [String]) {
    self.allowedSites = allowedSites
    guard enabled != self.enabled else { return }
    self.enabled = enabled
    if enabled { worker.async { _ = self.rulesNow() } }
    // The open tabs' next pages follow (their scripts are set up again).
    let reset = NSSelectorFromString("corvusResetScripts")
    for owner in owners.allObjects where owner.responds(to: reset) {
      owner.perform(reset)
    }
  }

  @objc private func scriptsReset(_ note: Notification) {
    guard let controller = note.object as? WKUserContentController, let owner = note.userInfo?["owner"] as? UIView else { return }
    owners.add(owner)
    controller.removeScriptMessageHandler(forName: Self.handlerName, contentWorld: Self.world)
    guard enabled, let script else { return }
    controller.addUserScript(script)
    controller.addScriptMessageHandler(ConsentHandler(owner: owner), contentWorld: Self.world, name: Self.handlerName)
  }

  fileprivate func receive(_ message: WKScriptMessage, from handler: ConsentHandler, reply: @escaping (Any?, String?) -> Void) {
    guard enabled, message.world == Self.world, let webView = message.webView, let owner = handler.owner,
          let parsed = ConsentMessage.parse(message.body) else { return reply(nil, nil) }
    let frame = message.frameInfo
    if case .initFrame = parsed, frame.isMainFrame { handler.messages = 0 }
    guard handler.messages < Self.maxMessages else { return reply(nil, nil) }
    handler.messages += 1
    switch parsed {
    case let .initFrame(url):
      // The address it gives must be its own; a frame's page is the tab's.
      guard ConsentMessage.originOf(url) == Self.origin(of: frame.securityOrigin),
            let pageUrl = frame.isMainFrame ? url : webView.url?.absoluteString,
            ConsentMessage.runsOn(pageUrl, allowedSites: allowedSites) else { return reply(nil, nil) }
      let mainFrame = frame.isMainFrame
      worker.async {
        let subset = self.rulesNow()?.forFrame(url, mainFrame: mainFrame)
        DispatchQueue.main.async { reply(subset, nil) }
      }
    case let .eval(snippetId):
      guard let source = snippets[snippetId] else { return reply(false, nil) }
      webView.callAsyncJavaScript("return await (\(source))();", arguments: [:], in: frame, in: .page) { result in
        if case let .success(value) = result { reply(Self.truthy(value), nil) } else { reply(false, nil) }
      }
    case .event:
      reply(nil, nil)
      let tag = owner.superview?.tag ?? 0
      guard var body = parsed.fields.map({ Dictionary($0, uniquingKeysWith: { a, _ in a }) }),
            body["type"] as? String != "settled", tag > 0 else { return }
      body["viewTag"] = tag
      body["mainFrame"] = frame.isMainFrame
      emit?(body)
    }
  }

  /// Boolean(value) of JavaScript, for a snippet's result.
  private static func truthy(_ value: Any?) -> Bool {
    switch value {
    case nil, is NSNull: return false
    case let number as NSNumber: return number.boolValue
    case let text as String: return !text.isEmpty
    default: return true
    }
  }

  /// A frame's origin as ConsentMessage.originOf writes it.
  private static func origin(of origin: WKSecurityOrigin) -> String? {
    let scheme = origin.protocol.lowercased()
    guard scheme == "http" || scheme == "https", !origin.host.isEmpty else { return nil }
    let host = origin.host.contains(":") && !origin.host.hasPrefix("[") ? "[\(origin.host.lowercased())]" : origin.host.lowercased()
    let port = origin.port
    let defaultPort = scheme == "https" ? 443 : 80
    return port == 0 || port == defaultPort ? "\(scheme)://\(host)" : "\(scheme)://\(host):\(port)"
  }

  private func rulesNow() -> ConsentRules? {
    if let rules { return rules }
    guard let text = asset("rules", "txt"), let parsed = ConsentRules.parse(text) else { return nil }
    parsed.prepare()
    rules = parsed
    return parsed
  }

  /// A file of the CorvusConsent resource bundle (built by scripts/consent-assets.mjs --ios).
  private func asset(_ name: String, _ ext: String) -> String? {
    for base in [Bundle.main, Bundle(for: ConsentKit.self)] {
      if let bundleUrl = base.url(forResource: "CorvusConsent", withExtension: "bundle"),
         let bundle = Bundle(url: bundleUrl),
         let url = bundle.url(forResource: name, withExtension: ext),
         let text = try? String(contentsOf: url, encoding: .utf8) {
        return text
      }
    }
    return nil
  }
}

/// One per WebView, registered in the consent world only. Holds its view weakly (the content
/// controller keeps the handler).
private final class ConsentHandler: NSObject, WKScriptMessageHandlerWithReply {
  weak var owner: UIView?
  /// Messages since the page loaded (main thread).
  var messages = 0

  init(owner: UIView) {
    self.owner = owner
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
    ConsentKit.shared.receive(message, from: self, reply: replyHandler)
  }
}
