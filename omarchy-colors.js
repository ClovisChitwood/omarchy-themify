// Omarchy Themify — color helpers.
// WCAG relative luminance + mixing, so polarity is derived from the actual
// palette instead of trusting a theme's declared "mode" (a theme can be named
// e.g. "day" and still ship a dark palette).
//
// Loaded as a content script before omarchy-surfaces.js / content.js; assigns
// to globalThis so it is also testable under Node.

(function () {
  "use strict";

  function parseHex(hex) {
    if (typeof hex !== "string") return null;
    let h = hex.trim().replace(/^#/, "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function toHex({ r, g, b }) {
    const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${c(r)}${c(g)}${c(b)}`;
  }

  // sRGB channel -> linear light
  function toLinear(c8) {
    const c = c8 / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  // WCAG relative luminance, 0 (black) .. 1 (white)
  function relLuminance(hex) {
    const rgb = typeof hex === "string" ? parseHex(hex) : hex;
    if (!rgb) return 0;
    return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
  }

  // WCAG contrast ratio between two colors, 1 .. 21
  function contrast(a, b) {
    const la = relLuminance(a);
    const lb = relLuminance(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Linear-ish mix of two colors; t=0 -> a, t=1 -> b
  function mix(a, b, t) {
    const ca = typeof a === "string" ? parseHex(a) : a;
    const cb = typeof b === "string" ? parseHex(b) : b;
    if (!ca || !cb) return typeof a === "string" ? a : toHex(ca || { r: 0, g: 0, b: 0 });
    const k = Math.max(0, Math.min(1, t));
    return toHex({
      r: ca.r + (cb.r - ca.r) * k,
      g: ca.g + (cb.g - ca.g) * k,
      b: ca.b + (cb.b - ca.b) * k,
    });
  }

  // Move `color` toward `toward` by t. Convenience wrapper over mix.
  function toward(color, towardColor, t) {
    return mix(color, towardColor, t);
  }

  function lighten(color, t) {
    return mix(color, "#ffffff", t);
  }

  function darken(color, t) {
    return mix(color, "#000000", t);
  }

  // Pick whichever of light/dark reads better on `bg`.
  function readableOn(bg, light = "#ffffff", dark = "#000000") {
    return contrast(bg, light) >= contrast(bg, dark) ? light : dark;
  }

  // Alpha-blend helper for rgba() strings.
  function withAlpha(hex, alpha) {
    const c = parseHex(hex);
    if (!c) return hex;
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.max(0, Math.min(1, alpha))})`;
  }

  // Hex -> HSL. Some sites (X/Twitter) define their design tokens as HSL
  // *component triples* -- "--color-text: 200 7% 91%" -- consumed as
  // hsl(var(--color-text)). Overriding those requires a triple, not a hex:
  // feeding a hex into hsl() produces invalid CSS, so the override silently
  // does nothing. Hence this converter.
  function hexToHsl(hex) {
    const c = typeof hex === "string" ? parseHex(hex) : hex;
    if (!c) return null;
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0, s = 0;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  // Hex -> "h s% l%" (the triple format X's tokens expect).
  function hslTriple(hex) {
    const x = hexToHsl(hex);
    return x ? `${x.h} ${x.s}% ${x.l}%` : null;
  }

  globalThis.OmarchyColors = {
    parseHex,
    toHex,
    relLuminance,
    contrast,
    mix,
    toward,
    lighten,
    darken,
    readableOn,
    withAlpha,
    hexToHsl,
    hslTriple,
  };
})();
