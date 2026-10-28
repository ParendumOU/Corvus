// Checks ConsentRules.swift and ConsentMessages.swift on a Mac (scripts/ios-consent-check.sh builds
// it with swiftc): the rules each frame gets are exactly what Autoconsent's filterCompactRules gives
// (cases.tsv, as ConsentRulesTest checks ConsentRules.kt), and the messages accepted are those the
// app and the Android module accept (messages.tsv).
// Usage: consent-check <rules.txt> <cases.tsv> <messages.tsv>
import CryptoKit
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: @autoclosure () -> String) {
  if !ok {
    failures += 1
    if failures <= 20 { print("FAIL: \(what())") }
  }
}

func read(_ path: String) -> String {
  guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
    print("cannot read \(path)")
    exit(2)
  }
  return text
}

func sha256(_ text: String) -> String {
  SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
}

func rows(_ text: String) -> [[String]] {
  text.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty && !$0.hasPrefix("#") }
    .map { $0.components(separatedBy: "\t") }
}

/// JSON.stringify of a string.
func quote(_ s: String) -> String {
  var out = "\""
  for scalar in s.unicodeScalars {
    switch scalar {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n": out += "\\n"
    case "\t": out += "\\t"
    case "\r": out += "\\r"
    default:
      if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
    }
  }
  return out + "\""
}

let args = CommandLine.arguments
guard args.count == 4 else {
  print("usage: consent-check <rules.txt> <cases.tsv> <messages.tsv>")
  exit(2)
}

// The rules.
let header = ConsentRules.header
check(ConsentRules.parse("corvus-consent-rules 0\n1\n") == nil, "a wrong header is refused")
check(ConsentRules.parse(header + "\n1\n0 1 0 1 1 1 0 0\n0\n1\n\n1\t5\t[]\n") == nil, "a rule using a missing string is refused")
check(ConsentRules.parse(header + "\n1\n0 1 0 1 1 1 0 0\n0\n1\n\n1\t\t[]\n") != nil, "a rule without strings is read")
check(ConsentRules.parse(header + "\n1\n0 0 0 0 0 0 0 0\n0\n0\n") != nil, "no rules is read")
guard let rules = ConsentRules.parse(read(args[1])) else {
  print("FAIL: rules.txt does not parse")
  exit(1)
}
check(rules.ruleCount > 500, "rules: \(rules.ruleCount)")
check(rules.brokenPatterns().isEmpty, "broken URL patterns: \(rules.brokenPatterns())")
let cases = rows(read(args[2]))
check(cases.count > 500, "cases: \(cases.count)")
let started = Date()
var specific = 0
let generic = Int(cases.first { $0[1] == "https://example.com/" }?[2] ?? "0") ?? 0
for c in cases {
  let mainFrame = c[0] == "main"
  let subset = rules.forFrame(c[1], mainFrame: mainFrame)
  check((subset.map(sha256) ?? "none") == c[3], "\(c[0]) \(c[1]): \(subset.map { "\($0.count) bytes" } ?? "none")")
  if mainFrame, (Int(c[2]) ?? 0) > generic { specific += 1 }
}
check(specific > 100, "pages with site rules: \(specific)")
print("rules: \(rules.ruleCount), \(cases.count) frames picked in \(Int(Date().timeIntervalSince(started) * 1000)) ms, \(specific) pages with site rules")

// The messages.
let messages = rows(read(args[3]))
check(messages.count > 25, "message cases: \(messages.count)")
for m in messages {
  let fields = ConsentMessage.parse(m[0])?.fields
  let json = fields.map { "{" + $0.map { key, value in quote(key) + ":" + ((value as? String).map(quote) ?? String(describing: value)) }.joined(separator: ",") + "}" } ?? "null"
  check(json == m[1], "message \(m[0]) -> \(json), expected \(m[1])")
}
check(ConsentMessage.parse("{\"type\":\"init\",\"url\":\"https://example.com/a?b\"}") == .initFrame(url: "https://example.com/a?b"), "init")
check(ConsentMessage.parse("{\"type\":\"init\",\"url\":\"javascript:alert(1)\"}") == nil, "init javascript:")
check(ConsentMessage.parse("{\"type\":\"init\",\"url\":\"about:blank\"}") == nil, "init about:blank")
check(ConsentMessage.parse("{\"type\":\"init\",\"url\":42}") == nil, "init number")
check(ConsentMessage.parse("not json") == nil, "not json")
check(ConsentMessage.parse(nil) == nil, "nil")
check(ConsentMessage.parse(["type": "settled"]) == nil, "not a string")
check(ConsentMessage.parse("{\"type\":\"init\",\"url\":\"https://example.com/\(String(repeating: "a", count: ConsentMessage.maxLength))\"}") == nil, "too long")
check(ConsentMessage.parse("{\"type\":\"eval\",\"snippetId\":\"EVAL_ONETRUST_1\"}") == .eval(snippetId: "EVAL_ONETRUST_1"), "eval by id")
check(ConsentMessage.parse("{\"type\":\"eval\",\"snippetId\":\"alert(1)\"}") == nil, "eval of code")
check(ConsentMessage.parse("{\"type\":\"eval\",\"code\":\"alert(1)\"}") == nil, "eval without id")
check(ConsentMessage.parse("{\"type\":\"eval\",\"snippetId\":\"EVAL_\(String(repeating: "A", count: 80))\"}") == nil, "eval long id")
check(ConsentMessage.originOf("https://Example.com:443/path?q#h") == "https://example.com", "origin default port")
check(ConsentMessage.originOf("http://10.0.2.2:18766/onetrust") == "http://10.0.2.2:18766", "origin port")
check(ConsentMessage.originOf("http://user:pw@example.com:80") == "http://example.com", "origin user info")
check(ConsentMessage.originOf("https://[::1]:8443/") == "https://[::1]:8443", "origin IPv6")
check(ConsentMessage.originOf("null") == nil, "origin null")
check(ConsentMessage.originOf("file:///a.html") == nil, "origin file")
check(ConsentMessage.originOf("https:///path") == nil, "origin no host")
let allowed = ["example.com", "news.org"]
check(!ConsentMessage.runsOn("https://www.example.com/a", allowedSites: allowed), "allowed www")
check(!ConsentMessage.runsOn("https://shop.example.com./", allowedSites: allowed), "allowed subdomain")
check(!ConsentMessage.runsOn("http://NEWS.org:8080/", allowedSites: allowed), "allowed case")
check(ConsentMessage.runsOn("https://example.org/", allowedSites: allowed), "other site")
check(ConsentMessage.runsOn("https://notexample.com/", allowedSites: allowed), "suffix only")
check(!ConsentMessage.runsOn("http://10.0.2.2:18766/onetrust", allowedSites: ["10.0.2.2"]), "allowed address")
check(!ConsentMessage.runsOn("about:blank", allowedSites: []), "about:blank")
print("messages: \(messages.count) cases")

if failures > 0 {
  print("CONSENT CHECK: \(failures) FAILED")
  exit(1)
}
print("CONSENT CHECK: OK")
