// Top-level domains recognised by the address bars (the desktop omnibox and the phone browser).
// Not the full public suffix list: common generic TLDs plus every ISO 3166-1 alpha-2 country code,
// which covers what people actually type.
const GENERIC = [
  "com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "name", "pro", "mobi", "aero", "coop",
  "museum", "jobs", "travel", "tel", "asia", "cat", "post", "xxx", "arpa",
  "io", "ai", "app", "dev", "page", "xyz", "online", "site", "website", "tech", "store", "shop", "blog",
  "cloud", "digital", "email", "news", "live", "life", "world", "today", "space", "studio", "design",
  "art", "media", "network", "systems", "solutions", "software", "agency", "company", "group", "club",
  "games", "game", "tv", "fm", "ly", "gg", "sh", "so", "to", "wiki", "link", "click", "top", "icu", "vip",
  "work", "rocks", "ninja", "guru", "zone", "center", "academy", "school", "university", "health",
  "bank", "finance", "money", "capital", "fund", "law", "legal", "realty", "house", "home", "land",
  "city", "town", "london", "berlin", "paris", "nyc", "tokyo", "madrid", "barcelona", "amsterdam",
  "google", "youtube", "microsoft", "apple", "amazon", "aws", "zip", "mov", "foo", "new", "eus", "gal",
  "local", "localhost", "test", "example", "invalid", "onion", "internal", "lan", "crypto",
  "eth", "chat", "social", "dating", "photo", "photos", "pics", "video", "music", "film", "movie",
  "codes", "build", "run", "tools", "computer", "host", "hosting", "domains", "services", "support",
  "fyi", "one", "plus", "inc", "llc", "ltd", "gmbh", "global", "earth", "green", "eco", "science",
  "data", "audio", "events", "expert", "exchange", "market", "markets", "sale", "deals",
];

const COUNTRY =
  "ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz " +
  "ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk " +
  "fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq " +
  "ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh " +
  "mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk " +
  "pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz " +
  "tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw";

export const KNOWN_TLDS: ReadonlySet<string> = new Set([...GENERIC, ...COUNTRY.split(" ")]);
