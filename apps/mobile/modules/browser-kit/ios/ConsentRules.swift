import Foundation

/// DuckDuckGo Autoconsent's compact rules (corvus-consent/rules.txt, packed by
/// scripts/consent-assets.mjs) and the rules one frame needs, picked the way Autoconsent's own
/// filterCompactRules does: a page gets the generic rules plus those written for its site, a frame
/// only the few that run in frames (none in most). The same as ConsentRules.kt on Android;
/// scripts/ios-consent-check.sh checks every pick against filterCompactRules itself (cases.tsv).
final class ConsentRules {
  static let header = "corvus-consent-rules 1"

  private let version: String
  private let ranges: [Int]
  /// JSON literals.
  private let strings: [String]
  private let patterns: [String]
  private let contexts: [Int]
  private let stringIds: [[Int]]
  /// JSON arrays.
  private let rules: [String]
  private var compiled: [NSRegularExpression?]
  private var broken: [Bool]
  private var genericAnswer: String?
  private var recent: [(key: String, value: String)] = []
  private let lock = NSLock()

  var ruleCount: Int { rules.count }

  private init(version: String, ranges: [Int], strings: [String], patterns: [String], contexts: [Int], stringIds: [[Int]], rules: [String]) {
    self.version = version
    self.ranges = ranges
    self.strings = strings
    self.patterns = patterns
    self.contexts = contexts
    self.stringIds = stringIds
    self.rules = rules
    compiled = Array(repeating: nil, count: rules.count)
    broken = Array(repeating: false, count: rules.count)
  }

  /// The ruleset (Autoconsent's compact JSON) for a frame at `url`; nil when no rule runs there.
  func forFrame(_ url: String, mainFrame: Bool) -> String? {
    lock.lock()
    defer { lock.unlock() }
    if !mainFrame {
      let picked = (ranges[2]..<ranges[3]).filter { runs($0, mainFrame: false, url: url) }
      if picked.isEmpty { return nil }
      return cached("f\(picked)") { serialize(picked, stringEnd: ranges[7], clear: true) }
    }
    let specific = (ranges[4]..<ranges[5]).filter { runs($0, mainFrame: true, url: url) }
    if specific.isEmpty { return generic() }
    return cached("m\(specific)") { serialize(Array(ranges[0]..<ranges[1]) + specific, stringEnd: strings.count, clear: true) }
  }

  /// Compiles the URL patterns and builds the generic answer before the first page asks (off the main thread).
  func prepare() {
    lock.lock()
    defer { lock.unlock() }
    _ = rules.indices.map { pattern($0) }
    _ = generic()
  }

  /// The URL patterns that do not compile here (ICU's regular expressions, not JavaScript's).
  func brokenPatterns() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return rules.indices.filter { !patterns[$0].isEmpty && pattern($0) == nil }.map { patterns[$0] }
  }

  private func generic() -> String {
    if let answer = genericAnswer { return answer }
    let answer = serialize(Array(ranges[0]..<ranges[1]), stringEnd: ranges[6], clear: false)
    genericAnswer = answer
    return answer
  }

  private func cached(_ key: String, _ make: () -> String) -> String {
    if let at = recent.firstIndex(where: { $0.key == key }) {
      let hit = recent.remove(at: at)
      recent.append(hit)
      return hit.value
    }
    let value = make()
    recent.append((key, value))
    if recent.count > 8 { recent.removeFirst() }
    return value
  }

  /// Autoconsent's shouldRunRuleInContext.
  private func runs(_ rule: Int, mainFrame: Bool, url: String) -> Bool {
    let context = contexts[rule]
    if mainFrame && context == 1 { return false }
    if !mainFrame && (context == 20 || context == 22 || context == 10 || context == 12) { return false }
    if patterns[rule].isEmpty { return true }
    guard let regex = pattern(rule) else { return false }
    return regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil
  }

  private func pattern(_ rule: Int) -> NSRegularExpression? {
    if broken[rule] { return nil }
    if let regex = compiled[rule] { return regex }
    guard let regex = try? NSRegularExpression(pattern: patterns[rule]) else {
      broken[rule] = true
      return nil
    }
    compiled[rule] = regex
    return regex
  }

  /// `{"v":…,"s":[…],"r":[…]}` for the picked rules, with the strings up to `stringEnd`; `clear`
  /// blanks the strings they do not use and drops those after the last used one (clearUnusedStrings).
  private func serialize(_ picked: [Int], stringEnd: Int, clear: Bool) -> String {
    var out = "{\"v\":\(version),\"s\":["
    out.reserveCapacity(64 * 1024)
    if clear {
      var used = [Bool](repeating: false, count: strings.count)
      var last = -1
      for rule in picked {
        for id in stringIds[rule] {
          used[id] = true
          if id > last { last = id }
        }
      }
      for i in 0..<min(stringEnd, last + 1) {
        if i > 0 { out += "," }
        out += used[i] ? strings[i] : "\"\""
      }
    } else {
      for i in 0..<stringEnd {
        if i > 0 { out += "," }
        out += strings[i]
      }
    }
    out += "],\"r\":["
    for (n, rule) in picked.enumerated() {
      if n > 0 { out += "," }
      out += rules[rule]
    }
    return out + "]}"
  }

  /// Reads rules.txt; nil when it is not this format.
  static func parse(_ text: String) -> ConsentRules? {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var at = 0
    func next() -> String? {
      guard at < lines.count else { return nil }
      defer { at += 1 }
      return lines[at]
    }
    guard next() == header,
          let version = next()?.trimmingCharacters(in: .whitespaces), Int(version) != nil,
          let rangeLine = next() else { return nil }
    let ranges = rangeLine.split(separator: " ").compactMap { Int($0) }
    guard ranges.count == 8, rangeLine.split(separator: " ").count == 8,
          let stringCount = next().flatMap({ Int($0) }), stringCount >= 0 else { return nil }
    var strings: [String] = []
    strings.reserveCapacity(stringCount)
    for _ in 0..<stringCount {
      guard let s = next() else { return nil }
      strings.append(s)
    }
    guard let count = next().flatMap({ Int($0) }), count >= 0 else { return nil }
    var patterns: [String] = [], contexts: [Int] = [], ids: [[Int]] = [], rules: [String] = []
    for _ in 0..<count {
      guard let pattern = next(), let line = next() else { return nil }
      let parts = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
      guard parts.count == 3, let context = Int(parts[0]) else { return nil }
      let used = parts[1].isEmpty ? [] : parts[1].split(separator: ",").map { Int($0) }
      guard used.allSatisfy({ $0 != nil && strings.indices.contains($0!) }),
            parts[2].hasPrefix("["), parts[2].hasSuffix("]") else { return nil }
      patterns.append(pattern)
      contexts.append(context)
      ids.append(used.map { $0! })
      rules.append(parts[2])
    }
    guard ranges.prefix(6).allSatisfy({ (0...count).contains($0) }),
          (0...strings.count).contains(ranges[6]), (0...strings.count).contains(ranges[7]) else { return nil }
    return ConsentRules(version: version, ranges: ranges, strings: strings, patterns: patterns, contexts: contexts, stringIds: ids, rules: rules)
  }
}
