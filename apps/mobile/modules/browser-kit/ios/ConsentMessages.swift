import Foundation

/// What a frame's cookie banner script (consent/page-ios.ts) sends the module. The script runs in a
/// content world of its own, out of the page's reach, but it reads the page's DOM, so every message
/// is still treated as untrusted: only these shapes are accepted, with exactly the fields expected
/// (the events as parseConsentEvent in @corvus/shared accepts them; the app checks them again), and
/// nothing in them is ever run. The same as ConsentMessages.kt on Android, plus `eval`, which only
/// names one of Autoconsent's bundled snippets.
enum ConsentMessage: Equatable {
  /// A frame asks for its rules.
  case initFrame(url: String)
  /// A frame asks to run one of Autoconsent's own snippets in the page (by id, never code).
  case eval(snippetId: String)
  /// What happened to a cookie banner (popupFound, optOutResult, autoconsentDone or settled).
  case event(type: String, cmp: String?, result: Bool?, isCosmetic: Bool?)

  /// Longer messages are dropped unread (an init carries one address; events a short name).
  static let maxLength = 4096
  private static let maxCmpName = 80

  static func parse(_ raw: Any?) -> ConsentMessage? {
    guard let raw = raw as? String, raw.utf16.count <= maxLength,
          let data = raw.data(using: .utf8),
          let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let type = msg["type"] as? String else { return nil }
    switch type {
    case "init":
      guard let url = msg["url"] as? String, originOf(url) != nil else { return nil }
      return .initFrame(url: url)
    case "eval":
      guard let id = msg["snippetId"] as? String, isSnippetId(id) else { return nil }
      return .eval(snippetId: id)
    case "settled":
      return .event(type: "settled", cmp: nil, result: nil, isCosmetic: nil)
    case "popupFound":
      guard let cmp = cmpName(msg) else { return nil }
      return .event(type: type, cmp: cmp, result: nil, isCosmetic: nil)
    case "optOutResult":
      guard let cmp = cmpName(msg), let result = bool(msg["result"]) else { return nil }
      return .event(type: type, cmp: cmp, result: result, isCosmetic: nil)
    case "autoconsentDone":
      guard let cmp = cmpName(msg), let cosmetic = bool(msg["isCosmetic"]) else { return nil }
      return .event(type: type, cmp: cmp, result: nil, isCosmetic: cosmetic)
    default:
      return nil
    }
  }

  /// The event for the app, in parseConsentEvent's field order (nil for init and eval).
  var fields: [(String, Any)]? {
    guard case let .event(type, cmp, result, isCosmetic) = self else { return nil }
    var out: [(String, Any)] = [("type", type)]
    if let cmp { out.append(("cmp", cmp)) }
    if let result { out.append(("result", result)) }
    if let isCosmetic { out.append(("isCosmetic", isCosmetic)) }
    return out
  }

  /// A JSON boolean (JSONSerialization gives NSNumber for both numbers and booleans).
  private static func bool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
  }

  private static func cmpName(_ msg: [String: Any]) -> String? {
    guard let cmp = msg["cmp"] as? String, !cmp.isEmpty, cmp.utf16.count <= maxCmpName,
          !cmp.unicodeScalars.contains(where: { $0.value < 0x20 }) else { return nil }
    return cmp
  }

  /// isConsentSnippetId of @corvus/shared.
  static func isSnippetId(_ value: String) -> Bool {
    value.utf16.count <= 80 && value.range(of: "^EVAL_[A-Z0-9_]+$", options: .regularExpression) != nil
  }

  private static let origin = try! NSRegularExpression(pattern: "^(https?)://([^/?#\\\\]*)", options: .caseInsensitive)

  /// "scheme://host[:port]" of an http(s) address (default ports left out, lower case); nil otherwise.
  static func originOf(_ url: String) -> String? {
    guard let match = origin.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
          let schemeRange = Range(match.range(at: 1), in: url), let authRange = Range(match.range(at: 2), in: url) else { return nil }
    let scheme = url[schemeRange].lowercased()
    var authority = String(url[authRange])
    if let at = authority.lastIndex(of: "@") { authority = String(authority[authority.index(after: at)...]) }
    authority = authority.lowercased()
    let port = scheme == "https" ? ":443" : ":80"
    if authority.hasSuffix(port) { authority.removeLast(port.count) }
    if authority.isEmpty || authority.hasPrefix(":") { return nil }
    return "\(scheme)://\(authority)"
  }

  /// The host of an http(s) address, as site lists store it (no "www.", no trailing dot).
  static func siteOf(_ url: String) -> String? {
    guard let authority = originOf(url).map({ String($0[$0.range(of: "://")!.upperBound...]) }) else { return nil }
    var host: String
    if authority.hasPrefix("[") {
      host = String(authority.prefix(while: { $0 != "]" })) + "]"
    } else {
      host = String(authority.prefix(while: { $0 != ":" }))
    }
    if host.hasSuffix(".") { host.removeLast() }
    if host.hasPrefix("www.") { host.removeFirst(4) }
    return host.isEmpty ? nil : host
  }

  /// Whether the cookie banner script may run for a tab's page (shouldRunConsent): a web page whose
  /// site is not one where the person keeps the banner.
  static func runsOn(_ pageUrl: String, allowedSites: [String]) -> Bool {
    guard let site = siteOf(pageUrl) else { return false }
    return !allowedSites.contains { site == $0 || site.hasSuffix(".\($0)") }
  }
}
