/**
 * Privacy protections beside the ad blocker: fingerprinting protection (Brave-style "farbling":
 * values sites read to tell browsers apart get a tiny, stable per-site noise) and sites forgotten
 * when their last tab closes. Pure rules here; main/adblock.ts wires them per profile.
 */

/** Whether `host` is `site` or one of its subdomains (both lower-case, without a leading "www."). */
export function siteMatches(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  const s = site.toLowerCase().replace(/^www\./, "");
  return s !== "" && (h === s || h.endsWith(`.${s}`));
}

/** 32-bit FNV-1a: the per-site seed of this browsing session (key) and the page's site. */
export function fingerprintSeed(key: string, site: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${key}|${site.toLowerCase().replace(/^www\./, "")}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 1;
}

/**
 * Runs first in every frame of a page: readbacks that fingerprint the device (canvas pixels,
 * WebGL pixels and renderer, audio samples, CPU count, device memory) come back slightly and
 * consistently different per site and per session, so they no longer identify you across sites.
 * Wrapped functions are Proxies, so they still look native to the page. Same-origin frames the
 * page reaches through an iframe (about:blank ones get no preload) are covered the same way.
 */
export function farblingScript(seed: number): string {
  return `(function () {
  var SEED = ${seed >>> 0};
  function rng(salt) {
    var x = (SEED ^ salt) >>> 0 || 1;
    return function () { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  }
  // Opaque pixels only: a transparent pixel with a colour would give the noise away, and would
  // not survive the premultiplied round trip of a canvas anyway.
  function noisePixels(data) {
    var r = rng(0x9e3779b9);
    for (var i = 0; i + 3 < data.length; i += 4) if (r() < 0.02 && data[i + 3] === 255) data[i] ^= 1;
    return data;
  }
  function wrap(obj, name, apply) {
    var orig = obj && obj[name];
    if (typeof orig !== "function") return;
    try { obj[name] = new Proxy(orig, { apply: function (t, self, args) { return apply(t, self, args); } }); } catch (e) {}
  }
  function wrapGetter(proto, name, get) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !d.get) return;
    try {
      Object.defineProperty(proto, name, { get: new Proxy(d.get, { apply: function (t, self, args) { return get(Reflect.apply(t, self, args)); } }), configurable: true, enumerable: d.enumerable });
    } catch (e) {}
  }
  function farble(W) {
    if (!W || W.__corvusFarbled) return;
    Object.defineProperty(W, "__corvusFarbled", { value: true });
    function noiseImage(t, self, args) {
      var img = Reflect.apply(t, self, args);
      noisePixels(img.data);
      return img;
    }
    var C2D = W.CanvasRenderingContext2D && W.CanvasRenderingContext2D.prototype;
    var getImageData = C2D && C2D.getImageData;
    wrap(C2D, "getImageData", noiseImage);
    wrap(W.OffscreenCanvasRenderingContext2D && W.OffscreenCanvasRenderingContext2D.prototype, "getImageData", noiseImage);
    function noisyCopy(canvas) {
      var w = canvas.width, h = canvas.height;
      if (!w || !h || w * h > 16777216 || !getImageData || !W.document) return null;
      var copy = W.document.createElement("canvas");
      copy.width = w; copy.height = h;
      var ctx = copy.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0);
      var img = Reflect.apply(getImageData, ctx, [0, 0, w, h]);
      noisePixels(img.data);
      ctx.putImageData(img, 0, 0);
      return copy;
    }
    var CANVAS = W.HTMLCanvasElement && W.HTMLCanvasElement.prototype;
    wrap(CANVAS, "toDataURL", function (t, self, args) {
      var copy = noisyCopy(self);
      return Reflect.apply(t, copy || self, args);
    });
    wrap(CANVAS, "toBlob", function (t, self, args) {
      var copy = noisyCopy(self);
      return Reflect.apply(t, copy || self, args);
    });
    [W.WebGLRenderingContext, W.WebGL2RenderingContext].forEach(function (GL) {
      if (!GL) return;
      wrap(GL.prototype, "getParameter", function (t, self, args) {
        if (args[0] === 37445) return "Google Inc.";
        if (args[0] === 37446) return "ANGLE (Generic GPU)";
        return Reflect.apply(t, self, args);
      });
      wrap(GL.prototype, "readPixels", function (t, self, args) {
        var out = Reflect.apply(t, self, args);
        var buf = args[6];
        if (buf && buf.length) noisePixels(buf);
        return out;
      });
    });
    var noisyBuffers = new WeakSet();
    wrap(W.AudioBuffer && W.AudioBuffer.prototype, "getChannelData", function (t, self, args) {
      var data = Reflect.apply(t, self, args);
      if (!noisyBuffers.has(data)) {
        noisyBuffers.add(data);
        var r = rng(0x85ebca6b + (args[0] | 0));
        for (var i = 0; i < data.length; i += 1) data[i] += (r() - 0.5) * 1e-7;
      }
      return data;
    });
    wrap(W.AnalyserNode && W.AnalyserNode.prototype, "getFloatFrequencyData", function (t, self, args) {
      var out = Reflect.apply(t, self, args);
      var arr = args[0], r = rng(0xc2b2ae35);
      if (arr) for (var i = 0; i < arr.length; i += 1) arr[i] += (r() - 0.5) * 0.1;
      return out;
    });
    var N = W.Navigator && W.Navigator.prototype;
    var cores = Math.max(2, Math.min(8, (W.navigator && W.navigator.hardwareConcurrency) || 4));
    var shownCores = 2 + Math.floor(rng(0x27d4eb2f)() * (cores - 1));
    wrapGetter(N, "hardwareConcurrency", function () { return shownCores; });
    wrapGetter(N, "deviceMemory", function () { return 8; });
    // A same-origin frame the page reaches into gets the same values as the page.
    var IFRAME = W.HTMLIFrameElement && W.HTMLIFrameElement.prototype;
    wrapGetter(IFRAME, "contentWindow", function (win) {
      try { farble(win); } catch (e) {}
      return win;
    });
    wrapGetter(IFRAME, "contentDocument", function (doc) {
      try { farble(doc && doc.defaultView); } catch (e) {}
      return doc;
    });
  }
  try { farble(window); } catch (e) {}
})();`;
}
