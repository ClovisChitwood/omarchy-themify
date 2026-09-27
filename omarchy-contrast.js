// Omarchy Themify — low-contrast text repair.
//
// The generic engine repaints *the page*, but it cannot see a site's own
// hardcoded colors. Plenty of sites (and nearly every HTML email) hardcode dark
// ink for an assumed white canvas — `color: #333` on a transparent background —
// so once the theme paints the canvas dark, that text goes invisible. Those
// colors are also frequently set inline or via a class the theme can't retint.
//
// So: after the theme is applied, walk the text-bearing elements, work out the
// *rendered* background behind each one (alpha-composited up the ancestor chain),
// and where the text/background contrast fails WCAG, nudge just that element's
// color toward a readable pole — preserving its hue, changing as little as
// possible, and never touching elements whose background can't be judged
// (photos, gradients, blend modes).
//
// Requires: omarchy-colors.js, omarchy-surfaces.js (loaded first).
// Idempotent: re-runs cleanly on theme change; every inline edit is recorded in
// a WeakMap so it can be reverted exactly (disable the extension, or switch
// themes, and the page's own colors come back).

(function () {
  "use strict";

  const C = globalThis.OmarchyColors;

  // ---------------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------------

  // WCAG 2.1 AA: 4.5:1 for body text, 3:1 for large text.
  const MIN_NORMAL = 4.5;
  const MIN_LARGE = 3.0;
  const LARGE_PX = 24;          // >= 24px is "large" whatever the weight
  const LARGE_BOLD_PX = 18.66;  // >= 18.66px bold is "large"
  const MIN_ALPHA = 0.55;       // fainter than this: decorative / gradient text, leave it
  const DEGRADED_ALPHA = 0.9;   // translucent ink is usually deliberate "dim" text
  const MIN_NORMAL_DIM = 4.0;   // ...so hold it to a slightly softer bar

  // Opt-outs: mark an element (or a subtree) to leave alone.
  const SKIP_SELECTOR = "[data-om-themify-skip], [data-om-themify-skip] *, [aria-hidden=\"true\"]";
  // Media / non-text boxes never carry glyphs we can judge.
  const SKIP_TAGS = {
    SVG: 1, CANVAS: 1, IMG: 1, VIDEO: 1, AUDIO: 1, PICTURE: 1, OBJECT: 1,
    EMBED: 1, IFRAME: 1, OPTION: 1, OPTGROUP: 1, SCRIPT: 1, STYLE: 1,
    NOSCRIPT: 1, TITLE: 1, HEAD: 1, MAP: 1, AREA: 1, TEMPLATE: 1,
  };
  const SKIP_TAGNAME = /^(svg|canvas|img|video|audio|picture|object|embed|iframe|option|script|style|head|title|template|map|area)$/i;
  // Backgrounds we must not guess at.
  const UNKNOWN_FILTER = /invert|blur|hue-rotate|sepia|grayscale|url\(/i;

  // Budgets: keep a pass bounded on huge pages, and only look at text near the
  // viewport — offscreen text gets caught when it scrolls in.
  const MAX_CHECKS_PER_PASS = 2500;
  const MAX_COLLECT_PER_JUMP = 8000;
  const BAND_ABOVE = 600;
  const BAND_BELOW = 1200;
  const DEBOUNCE_MS = 120;

  const ATTR = "data-om-themify-contrast";
  const STYLE_ID = "omarchy-themify-style";

  // ---------------------------------------------------------------------------
  // Pure color core — no DOM, so it is testable under plain Node.
  // ---------------------------------------------------------------------------

  function num(p) {
    return p.endsWith("%") ? parseFloat(p) * 2.55 : parseFloat(p);
  }

  /** Parse a CSS color to {r,g,b,a}; null when unsupported (color(srgb …), var(), invalid). */
  function parseColor(value) {
    if (typeof value !== "string") return null;
    const s = value.trim().toLowerCase();
    if (!s) return null;
    if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    const hex = C.parseHex(s);
    if (hex) return { r: hex.r, g: hex.g, b: hex.b, a: 1 };
    const m = s.match(/^rgba?\(([^)]*)\)$/);
    if (!m) return null;
    const parts = m[1].split(/[\s,\/]+/).filter((p) => p.length);
    if (parts.length < 3) return null;
    const out = { r: num(parts[0]), g: num(parts[1]), b: num(parts[2]), a: 1 };
    if (parts.length > 3) {
      const raw = parts[3];
      out.a = raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
    }
    if (!isFinite(out.r) || !isFinite(out.g) || !isFinite(out.b) || !isFinite(out.a)) return null;
    return out;
  }

  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  function opaque(c) { return { r: clamp(c.r), g: clamp(c.g), b: clamp(c.b) }; }

  /** Alpha-composite `fg` (which may be translucent) over opaque `bg`. */
  function over(fg, bg) {
    if (!fg) return bg;
    const a = fg.a == null ? 1 : fg.a;
    if (a >= 1) return opaque(fg);
    if (a <= 0) return bg;
    return {
      r: clamp(fg.r * a + bg.r * (1 - a)),
      g: clamp(fg.g * a + bg.g * (1 - a)),
      b: clamp(fg.b * a + bg.b * (1 - a)),
    };
  }

  function mixRgb(a, b, t) {
    const k = t < 0 ? 0 : t > 1 ? 1 : t;
    return {
      r: clamp(a.r + (b.r - a.r) * k),
      g: clamp(a.g + (b.g - a.g) * k),
      b: clamp(a.b + (b.b - a.b) * k),
    };
  }

  function hexOf(c) { return C.toHex(opaque(c)); }

  /** True when two CSS colour strings denote the same colour.
   *  Chromium normalises `#837965` to `rgb(131, 121, 101)` in the CSSOM, so a
   *  raw string comparison would miss our own value on revert. */
  function sameColor(a, b) {
    const ca = parseColor(a);
    const cb = parseColor(b);
    if (ca && cb) {
      const r = (c) => [Math.round(c.r), Math.round(c.g), Math.round(c.b), Math.round((c.a == null ? 1 : c.a) * 100)];
      return r(ca).join(",") === r(cb).join(",");
    }
    if (ca || cb) return false;
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  }

  function ratioOf(a, b) { return C.contrast(hexOf(a), hexOf(b)); }

  /** The pure pole (white or black) that reads best on `bg`. */
  function bestPole(bg) {
    return ratioOf({ r: 255, g: 255, b: 255 }, bg) >= ratioOf({ r: 0, g: 0, b: 0 }, bg)
      ? { r: 255, g: 255, b: 255 }
      : { r: 0, g: 0, b: 0 };
  }

  /**
   * Smallest move from `fg` toward one of `poles` that reaches `minRatio` against
   * `bg`. Hue is preserved because the move is a mix, not a replacement; `poles`
   * are tried in order (theme-matching pole first).
   *
   * @returns {{color:{r,g,b}, hex:string, ratio:number, t:number, capped:boolean}|null}
   *          null when the text already passes.
   */
  function repair(fg, bg, minRatio, poles) {
    const start = ratioOf(fg, bg);
    if (start >= minRatio) return null;

    const list = (poles && poles.length ? poles : [bestPole(bg)]).map(opaque);

    for (const pole of list) {
      if (ratioOf(pole, bg) < minRatio) continue; // this pole cannot get there
      // Contrast rises monotonically as the colour moves toward the pole, so
      // bisect for the smallest sufficient t: the least visually invasive fix.
      let lo = 0, hi = 1, best = null;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (ratioOf(mixRgb(fg, pole, mid), bg) >= minRatio) { best = mid; hi = mid; }
        else lo = mid;
      }
      const t = best == null ? 1 : best;
      const color = mixRgb(fg, pole, t);
      const ratio = ratioOf(color, bg);
      if (ratio < minRatio) continue;
      return { color, hex: hexOf(color), ratio, t, capped: false };
    }

    // Even a full move can't reach the bar (saturated panel behind the text).
    // Take the best achievable so it is at least as readable as possible.
    let bestPoleRgb = list[0], bestRatio = -1;
    for (const p of list) {
      const r = ratioOf(p, bg);
      if (r > bestRatio) { bestRatio = r; bestPoleRgb = p; }
    }
    return { color: bestPoleRgb, hex: hexOf(bestPoleRgb), ratio: bestRatio, t: 1, capped: true };
  }

  // ---------------------------------------------------------------------------
  // DOM layer
  // ---------------------------------------------------------------------------

  const state = {
    on: false,
    surfaces: null,
    orig: new WeakMap(),   // el -> {had, prev, value}  (inline color we replaced)
    seen: new WeakSet(),   // el -> already evaluated (or deliberately skipped)
    touched: new WeakSet(),// el -> we wrote an inline style here (observer guard)
    fixedList: [],         // elements with an active repair, for exact revert
    candidates: [],        // text-bearing elements found by the collector
    candSeen: new WeakSet(), // dedupe guard for repeated collects
    observer: null,
    timer: null,
    running: false,
    bound: false,
    stats: { checked: 0, fixed: 0, skipped: 0, passes: 0 },
  };

  function supported() {
    return typeof document !== "undefined" && typeof window !== "undefined" &&
      typeof window.getComputedStyle === "function" && typeof document.createElement === "function";
  }

  function cs(node) {
    try { return window.getComputedStyle(node); } catch (_) { return null; }
  }

  /** Next ancestor, crossing open shadow-root boundaries. */
  function parentOf(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    return root && root.host ? root.host : null;
  }

  /**
   * The colour actually rendered behind `el`'s text: composite every
   * non-transparent background from the element outward, farthest first.
   * Returns null when it cannot be known (background image / gradient / filter
   * / blend mode somewhere up the chain), in which case we leave the text alone.
   */
  function effectiveBg(el) {
    const chain = [];
    let node = el;
    let guard = 0;

    while (node && node.nodeType === 1 && guard++ < 64) {
      const s = cs(node);
      if (!s) return null;
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      if (s.backgroundBlendMode && s.backgroundBlendMode !== "normal") return null;
      if (s.mixBlendMode && s.mixBlendMode !== "normal") return null;
      if (s.filter && UNKNOWN_FILTER.test(s.filter)) return null;
      if (parseFloat(s.opacity) < 1) return null;

      const bg = parseColor(s.backgroundColor);
      if (bg && bg.a > 0) {
        chain.push(bg);
        if (bg.a >= 1) break; // opaque: nothing below can show through
      }
      node = parentOf(node);
    }

    // Nothing opaque anywhere up the chain: the browser canvas (white) shows.
    let acc = { r: 255, g: 255, b: 255 };
    for (let i = chain.length - 1; i >= 0; i--) acc = over(chain[i], acc);
    return acc;
  }

  function hasDirectText(el) {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim().length) return true;
    }
    return false;
  }

  function isLargeText(s) {
    const px = parseFloat(s.fontSize) || 0;
    if (px >= LARGE_PX) return true;
    const weight = s.fontWeight === "bold" ? 700 : parseInt(s.fontWeight, 10) || 400;
    return px >= LARGE_BOLD_PX && weight >= 700;
  }

  /** Candidate collection: elements holding text, descending through shadow roots.
   *  Idempotent — the same element is never queued twice. */
  function collect(root) {
    if (!root) return;
    const stack = [root];
    let budget = MAX_COLLECT_PER_JUMP;
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      if (!node || node.nodeType !== 1) continue;
      if (SKIP_TAGS[node.tagName] || SKIP_TAGNAME.test(node.tagName)) continue;
      if (hasDirectText(node) && !state.candSeen.has(node)) {
        state.candSeen.add(node);
        state.candidates.push(node);
      }
      for (let child = node.firstElementChild; child; child = child.nextElementSibling) stack.push(child);
      const shadow = node.shadowRoot;
      if (shadow) for (let child = shadow.firstElementChild; child; child = child.nextElementSibling) stack.push(child);
    }
  }

  /** Poles tried in order for a given background: the theme's own text colour
   *  first (so fixes keep the theme's cast), then the pure best pole. */
  function polesFor(bg, surfaces) {
    const dark = (surfaces || {}).polarity !== "light";
    const poles = [];
    const theme = themePole(surfaces, dark);
    if (theme) poles.push(theme);
    const pure = bestPole(bg);
    if (!theme || hexOf(theme) !== hexOf(pure)) poles.push(pure);
    return poles;
  }

  function themePole(surfaces, dark) {
    const s = surfaces || {};
    const c = parseColor(s.fgBright) || parseColor(s.fg);
    if (!c) return null;
    // On a dark theme the readable direction is "brighter than the canvas"; on a
    // light theme it is "darker". If the palette contradicts that, don't use it.
    const lum = C.relLuminance(hexOf(c));
    if (dark && lum < 0.5) return null;
    if (!dark && lum > 0.5) return null;
    return opaque(c);
  }

  function evaluate(el) {
    const s = cs(el);
    if (!s || s.display === "none" || s.visibility === "hidden") return;

    const fg = parseColor(s.color);
    if (!fg) return;                                   // color(srgb …) / unresolved var()
    const alpha = fg.a == null ? 1 : fg.a;
    if (alpha < MIN_ALPHA) return;                     // intentionally invisible / gradient text

    // Clipped/gradient text paints with -webkit-text-fill-color, not `color`:
    // if that differs (or is transparent), our reading of `color` is fiction.
    if (s.backgroundClip && /text/.test(s.backgroundClip)) return;
    const fill = parseColor(s.webkitTextFillColor);
    if (fill && (fill.a == null ? 1 : fill.a) < MIN_ALPHA) return;
    if (fill && hexOf(fill) !== hexOf(fg)) return;

    const bg = effectiveBg(el);
    if (!bg) { state.stats.skipped++; return; }         // over a photo/gradient: unjudgeable

    const ink = over(fg, bg);                          // what the glyphs really look like
    const large = isLargeText(s);
    const base = large ? MIN_LARGE : alpha < DEGRADED_ALPHA ? MIN_NORMAL_DIM : MIN_NORMAL;
    const min = Math.max(1, base);

    const res = repair(ink, bg, min, polesFor(bg, state.surfaces));
    if (!res) return;

    setColor(el, res.hex);
    state.stats.fixed++;
  }

  function setColor(el, hex) {
    const rec = state.orig.get(el);
    if (rec) {
      rec.value = hex;
    } else {
      const prev = el.style ? el.style.getPropertyValue("color") : "";
      state.orig.set(el, {
        had: !!prev,
        prev: prev,
        prevImportant: el.style ? el.style.getPropertyPriority("color") === "important" : false,
        value: hex,
      });
      state.fixedList.push(el);
    }
    state.touched.add(el);
    try {
      el.style.setProperty("color", hex, "important");
      el.setAttribute(ATTR, "fixed");
    } catch (_) {}
  }

  function revert(el) {
    const rec = state.orig.get(el);
    if (!rec || !el.style) return;
    // Only if our value is still in place — don't clobber a later page change.
    if (sameColor(el.style.getPropertyValue("color"), rec.value)) {
      if (rec.had) el.style.setProperty("color", rec.prev, rec.prevImportant ? "important" : "");
      else el.style.removeProperty("color");
    }
    try { el.removeAttribute(ATTR); } catch (_) {}
  }

  function revertAll() {
    for (const el of state.fixedList) revert(el);
    state.fixedList = [];
    state.orig = new WeakMap();
  }

  function inBand(rect) {
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    return rect.bottom > -BAND_ABOVE && rect.top < vh + BAND_BELOW;
  }

  function runPass() {
    state.timer = null;
    if (!state.on || state.running) return;
    state.running = true;
    state.stats.passes++;
    let checks = 0;
    let more = false;
    try {
      for (const el of state.candidates) {
        if (state.seen.has(el)) continue;
        if (!el.isConnected) { state.seen.add(el); continue; }
        let rect;
        try { rect = el.getBoundingClientRect(); } catch (_) { state.seen.add(el); continue; }
        if (rect.width <= 1 || rect.height <= 1) continue;   // screen-reader-only / collapsed
        if (!inBand(rect)) continue;                          // caught when it scrolls in
        if (el.closest && el.closest(SKIP_SELECTOR)) { state.seen.add(el); continue; }
        if (checks >= MAX_CHECKS_PER_PASS) { more = true; break; }
        checks++;
        state.seen.add(el);
        state.stats.checked++;
        evaluate(el);
      }
    } finally {
      state.running = false;
    }
    if (more) schedule(DEBOUNCE_MS);
  }

  function schedule(delay) {
    if (!state.on) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(runPass, delay == null ? DEBOUNCE_MS : delay);
  }

  function onMutations(records) {
    if (!state.on) return;
    for (const rec of records) {
      if (rec.type === "attributes") {
        const t = rec.target;
        if (!t || t.nodeType !== 1) continue;
        if (state.touched.has(t)) continue;       // our own -- not a loop
        if (t.id === STYLE_ID) continue;
        state.seen.delete(t);                     // re-judge just this element
        continue;
      }
      for (const n of rec.addedNodes) {
        if (n && n.nodeType === 1) collect(n);
      }
    }
    schedule();
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    try {
      state.observer = new MutationObserver(onMutations);
      // The document element may not exist yet (content scripts can run before
      // the parser creates it); observing the Document node still reports the
      // html element's insertion, so nothing is missed either way.
      state.observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    } catch (_) { state.observer = null; }
    const wake = () => schedule(60);
    // By DOM-ready everything initial is parsed: re-collect (cheap, deduped) so
    // nothing that arrived before the observer was live is missed.
    const settle = () => { collect(document.documentElement); schedule(0); };
    try {
      window.addEventListener("scroll", wake, { passive: true });
      window.addEventListener("resize", wake, { passive: true });
      document.addEventListener("DOMContentLoaded", settle);
      window.addEventListener("load", settle);
    } catch (_) {}
  }

  function unbind() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    state.bound = false;
    state.candidates = [];
    state.candSeen = new WeakSet();
    state.seen = new WeakSet();
    state.touched = new WeakSet();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function start(opts) {
    if (!supported()) return false;
    state.surfaces = (opts && opts.surfaces) || state.surfaces;
    state.on = true;
    bind();
    if (!state.candidates.length) collect(document.documentElement);
    schedule(0);
    return true;
  }

  function stop() {
    state.on = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    unbind();
    revertAll();
    return true;
  }

  /** Theme changed: drop every repair (the old colours are wrong now) and redo. */
  function refresh(opts) {
    if (!supported()) return false;
    if (opts && opts.surfaces) state.surfaces = opts.surfaces;
    revertAll();
    state.seen = new WeakSet();
    state.candidates = [];
    state.candSeen = new WeakSet();
    if (!state.on) return false;
    collect(document.documentElement);
    schedule(0);
    return true;
  }

  globalThis.OmarchyContrast = {
    start,
    stop,
    refresh,
    runNow: () => { if (state.on) { collect(document.documentElement); runPass(); } },
    stats: () => ({ ...state.stats }),
    // exposed for tests / debugging
    effectiveBg,
    hasDirectText,
    parseColor,
    over,
    mixRgb,
    repair,
    bestPole,
    polesFor,
    MIN_NORMAL,
    MIN_LARGE,
    MIN_ALPHA,
    ATTR,
  };
})();
