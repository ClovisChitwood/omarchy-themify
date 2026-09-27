// Omarchy Themify — MAIN-world prefers-color-scheme override.
//
// Runs in the page's own JS context at document_start, before app scripts.
// Most web apps decide their light/dark theme by reading
// `matchMedia('(prefers-color-scheme: dark)')`. A normal content script runs in
// an isolated world and CANNOT change what that returns — which is why an
// extension can normally only paint over an app's light UI, never make the app
// itself go dark. Overriding matchMedia here at the source is what fixes that.
//
// How this instance learns the desired scheme:
//   1. Synchronously from localStorage at boot (repeat visits get it right
//      BEFORE the app reads it — the important case).
//   2. A window.postMessage from the content script when the palette arrives or
//      the theme changes.
//   3. A MutationObserver on <html data-omarchy-scheme> as a safety net.
//
// Until it knows, it delegates to the native matchMedia, so behaviour never
// regresses on a first visit.

(function () {
  "use strict";

  if (globalThis.__omarchyThemifyMatchMedia) return;
  globalThis.__omarchyThemifyMatchMedia = true;

  const STORAGE_KEY = "omarchy-themify:scheme";
  const ATTR = "data-omarchy-scheme";

  const nativeMatchMedia = window.matchMedia.bind(window);
  const tracked = new Set();
  let desired = null; // "dark" | "light" | null

  function readStored() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === "dark" || v === "light") return v;
    } catch (_) {
      /* storage blocked; fall through */
    }
    return null;
  }

  desired = readStored();

  // Which polarity does this query want? null => not a scheme query.
  function wantedPolarity(query) {
    const q = String(query).toLowerCase();
    if (!q.includes("prefers-color-scheme")) return null;
    const wantsDark = q.includes("dark");
    const wantsLight = q.includes("light");
    if (!wantsDark && !wantsLight) return null;
    // A query could theoretically name both; treat as inconclusive.
    if (wantsDark && wantsLight) return null;
    return wantsDark ? "dark" : "light";
  }

  function effectiveScheme() {
    if (desired) return desired;
    // Safety net: the attribute may be set even if the message was missed.
    try {
      const a = document.documentElement.getAttribute(ATTR);
      if (a === "dark" || a === "light") return a;
    } catch (_) {}
    return null;
  }

  class SchemeMQL extends EventTarget {
    constructor(query) {
      super();
      this.media = query;
      this.onchange = null;
    }
    get matches() {
      const want = wantedPolarity(this.media);
      const cur = effectiveScheme();
      if (want === null || cur === null) {
        // Unknown -> defer to the OS value rather than lying.
        return nativeMatchMedia(this.media).matches;
      }
      return want === cur;
    }
    // Legacy Safari/Chrome API
    addListener(cb) {
      this.addEventListener("change", cb);
    }
    removeListener(cb) {
      this.removeEventListener("change", cb);
    }
  }

  function notifyChange() {
    for (const mql of tracked) {
      try {
        const ev = new Event("change");
        // Give the event an `matches` snapshot for consumers that read it.
        Object.defineProperty(ev, "matches", { value: mql.matches, enumerable: true });
        mql.dispatchEvent(ev);
        if (typeof mql.onchange === "function") mql.onchange(ev);
      } catch (_) {
        /* one bad listener must not stop the rest */
      }
    }
  }

  window.matchMedia = function matchMedia(query) {
    if (wantedPolarity(query) === null) return nativeMatchMedia(query);
    const mql = new SchemeMQL(query);
    tracked.add(mql);
    return mql;
  };

  function setScheme(value, { force = false } = {}) {
    if (value !== "dark" && value !== "light") return;
    if (!force && value === desired) return;
    desired = value;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (_) {}
    notifyChange();
  }

  // Channel 2: content script -> MAIN world.
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== "object" || d.__omarchyThemifyScheme === undefined) return;
    setScheme(d.__omarchyThemifyScheme);
  });

  // Channel 3: attribute safety net.
  function observeAttr() {
    try {
      const mo = new MutationObserver(() => {
        const a = document.documentElement.getAttribute(ATTR);
        if (a === "dark" || a === "light") setScheme(a);
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: [ATTR] });
    } catch (_) {}
  }

  if (document.documentElement) observeAttr();
  else document.addEventListener("DOMContentLoaded", observeAttr, { once: true });

  // Expose a tiny API for the content script's page-world shim (belt & braces).
  globalThis.__omarchyThemifySetScheme = setScheme;
})();
