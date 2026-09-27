// Omarchy Themify — content script (isolated world).
//
// Receives the current Omarchy theme palette, derives a coherent surface set
// from it (WCAG luminance decides dark/light, not the theme's label), recolors
// the page, and — crucially — tells the MAIN-world shim what polarity to report
// for `prefers-color-scheme`, so apps that gate their own dark mode follow the
// desktop theme instead of fighting it.
//
// Requires: omarchy-colors.js, omarchy-surfaces.js (loaded first).
// Idempotent: safe on repeat runs / theme switches.

(function () {
  "use strict";

  const C = globalThis.OmarchyColors;
  const S = globalThis.OmarchySurfaces;
  const X = globalThis.OmarchyContrast;

  const PALETTE_MSG = "omarchy-themify:palette";
  const STATS_MSG = "omarchy-themify:contrast-stats";
  const STYLE_ID = "omarchy-themify-style";
  const ATTR = "data-omarchy-scheme";
  const STORAGE_KEY = "omarchy-themify:scheme";

  let enabled = true;
  let contrastOn = false;
  let pendingApply = null; // palette that arrived before the document existed
  let deferBound = false;
  let deferObserver = null;

  // -------------------------------------------------------------------------
  // Per-site overrides, loaded from omarchy-sites.js (globalThis.OmarchySites),
  // keyed by hostname (www. stripped). Each entry may be a CSS string or
  // (surfaces, vars) => string. Packs use the --om-* variables so they keep
  // following the live theme. See omarchy-sites.js to add a site.
  // -------------------------------------------------------------------------
  const OMARCHY_SITES = globalThis.OmarchySites || {};

  function escapeCss(s) {
    return String(s).replace(/[\\\n\r]/g, (m) => (m === "\\" ? "\\\\" : ""));
  }

  // -------------------------------------------------------------------------
  // CSS variable contract + generic recolor. Exposed as --om-* so per-site
  // stylesheets can consume the same palette.
  // -------------------------------------------------------------------------

  function buildVars(s) {
    return {
      "--om-polarity": s.polarity,
      "--om-bg": s.bg,
      "--om-bg-deep": s.bgDeep,
      "--om-bg-sunken": s.bgSunken,
      "--om-bg-raise": s.bgRaise,
      "--om-bg-raise-2": s.bgRaise2,
      "--om-border": s.border,
      "--om-border-strong": s.borderStrong,
      "--om-fg": s.fg,
      "--om-fg-bright": s.fgBright,
      "--om-fg-dim": s.fgDim,
      "--om-accent": s.accent,
      "--om-accent-on": s.onAccent,
      "--om-selection": s.selection,
      "--om-muted": s.muted,
      "--om-red": s.ansi.red,
      "--om-green": s.ansi.green,
      "--om-yellow": s.ansi.yellow,
      "--om-blue": s.ansi.blue,
      "--om-magenta": s.ansi.magenta,
      "--om-cyan": s.ansi.cyan,
      "--om-orange": s.ansi.orange,
      "--om-brown": s.ansi.brown,
    };
  }

  function varsBlock(v) {
    return Object.entries(v)
      .map(([k, val]) => `${k}: ${escapeCss(val)};`)
      .join("\n    ");
  }

  // Generic rules, conservative: swap surfaces + text roles, never touch media
  // rendering or layout. Polarity-specific so a light theme doesn't force dark.
  // Rules reference the --om-* custom properties rather than literals, so a
  // per-site stylesheet can retint a subtree by redefining them.
  function genericRules(s) {
    if (s.polarity === "dark") {
      return `
  :root { color-scheme: dark; }
  html { background: var(--om-bg-deep); }
  body { background-color: transparent; color: var(--om-fg); }
  a { color: var(--om-accent); }
  a:hover { color: var(--om-fg-bright); }
  a:visited { color: var(--om-cyan); }
  ::selection { background: var(--om-selection); color: var(--om-fg-bright); }
  h1, h2, h3, h4, h5, h6 { color: var(--om-fg-bright); }
  mark { background: var(--om-accent); color: var(--om-accent-on); }
  blockquote { border-color: var(--om-border); color: var(--om-fg-dim); }
  hr { border-color: var(--om-border); }
  code, pre, kbd, samp { color: var(--om-yellow); }
  input, select, textarea, button { color: var(--om-fg); }
  [type="text"], [type="search"], [type="email"], [type="password"], [type="url"],
  [type="number"], textarea, select {
    background-color: var(--om-bg-raise);
    border-color: var(--om-border);
    color: var(--om-fg);
  }
  `;
    }
    return `
  :root { color-scheme: light; }
  html { background: var(--om-bg-deep); }
  body { background-color: transparent; color: var(--om-fg); }
  a { color: var(--om-accent); }
  a:hover { color: var(--om-accent-on); }
  a:visited { color: var(--om-cyan); }
  ::selection { background: var(--om-selection); color: var(--om-fg-bright); }
  h1, h2, h3, h4, h5, h6 { color: var(--om-fg-bright); }
  hr { border-color: var(--om-border); }
  blockquote { border-color: var(--om-border); color: var(--om-fg-dim); }
  `;
  }

  function siteRules(s, v) {
    const host = location.hostname.replace(/^www\./, "").toLowerCase();
    const entry = OMARCHY_SITES[host];
    if (!entry) return "";
    return typeof entry === "function" ? entry(s, v) : entry;
  }

  // -------------------------------------------------------------------------
  // MAIN-world channel: tell the page's own JS which scheme to report.
  // Both a postMessage (live) and the html attribute (safety net) are used.
  // -------------------------------------------------------------------------

  function publishScheme(polarity) {
    try {
      document.documentElement.setAttribute(ATTR, polarity);
    } catch (_) {}
    try {
      localStorage.setItem(STORAGE_KEY, polarity);
    } catch (_) {}
    try {
      window.postMessage({ __omarchyThemifyScheme: polarity }, "*");
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Apply / remove
  // -------------------------------------------------------------------------

  function removeStyle() {
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
  }

  // Deferred first paint: run the held palette as soon as <html> exists.
  function flushPending() {
    if (!pendingApply || !document.documentElement) return;
    const p = pendingApply;
    pendingApply = null;
    if (deferObserver) { try { deferObserver.disconnect(); } catch (_) {} deferObserver = null; }
    applyPalette(p.palette, p.isEnabled, p.repair);
  }

  function waitForDocumentElement() {
    if (deferBound) return;
    deferBound = true;
    try { document.addEventListener("DOMContentLoaded", flushPending); } catch (_) {}
    try { document.addEventListener("readystatechange", flushPending); } catch (_) {}
    try {
      deferObserver = new MutationObserver(flushPending);
      deferObserver.observe(document, { childList: true, subtree: true });
    } catch (_) { deferObserver = null; }
  }

  function applyPalette(palette, isEnabled, repair) {
    // A content script can run before the parser has created <html> (about:blank
    // and srcdoc frames, or document_start in an empty document). There is no
    // tree to style yet, so hold the palette and apply it as soon as there is.
    if (!document.documentElement) {
      pendingApply = { palette, isEnabled, repair };
      waitForDocumentElement();
      return;
    }

    enabled = isEnabled !== false;
    removeStyle();
    if (!enabled) {
      // Give the page its own colors back before bailing out.
      if (X && contrastOn) { try { X.stop(); } catch (_) {} contrastOn = false; }
      return;
    }

    const surfaces = S.deriveSurfaces(palette || {});
    // Tell the app which polarity to use BEFORE/alongside painting it.
    publishScheme(surfaces.polarity);

    const vars = buildVars(surfaces);
    const css =
      `/* Omarchy Themify — theme: ${escapeCss(surfaces.name)} ` +
      `(${surfaces.polarity}, lum ${surfaces.luminance}, ` +
      `contrast ${surfaces.contrast.fgOnBg}:1) */\n` +
      `:root {\n    ${varsBlock(vars)}\n  }\n` +
      genericRules(surfaces) +
      `\n/* per-site */\n` +
      siteRules(surfaces, vars);

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    // Second pass: repair text the theme made unreadable (hardcoded dark ink on
    // a now-dark canvas, etc). Only ever adjusts text colour, never layout.
    if (X && repair !== false) {
      try {
        if (contrastOn) X.refresh({ surfaces });
        else contrastOn = X.start({ surfaces }) !== false;
      } catch (_) {}
    } else if (X && contrastOn) {
      try { X.stop(); } catch (_) {}
      contrastOn = false;
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === PALETTE_MSG) {
      applyPalette(msg.palette, msg.enabled !== false, msg.repair);
      return false;
    }
    if (msg.type === STATS_MSG) {
      // Popup readout: how much of this page needed repairing.
      sendResponse({
        enabled: enabled,
        contrast: contrastOn,
        stats: X ? X.stats() : null,
      });
      return false;
    }
    return false;
  });

  // Request the cached palette; the worker will also broadcast on theme change.
  chrome.runtime.sendMessage({ type: "omarchy-themify:get-palette" }, (resp) => {
    if (chrome.runtime.lastError) return; // worker asleep/restarting
    if (resp && resp.palette) applyPalette(resp.palette, resp.enabled !== false, resp.repair);
  });
})();
