// Omarchy Themify — surface derivation.
// Turns a raw Omarchy palette into a coherent set of surfaces (base, raised,
// sunken, borders, text, accent) with contrast guarantees, choosing dark or
// light polarity from WCAG luminance rather than the theme's declared mode.
//
// Loaded after omarchy-colors.js; assigns to globalThis.

(function () {
  "use strict";

  const C = globalThis.OmarchyColors;

  // Minimum readable contrast for body text against the page background.
  const MIN_TEXT_CONTRAST = 4.5;

  function pick(palette, ...keys) {
    for (const k of keys) {
      if (palette && typeof palette[k] === "string" && C.parseHex(palette[k])) {
        return palette[k];
      }
    }
    return null;
  }

  /**
   * Derive surfaces from an Omarchy palette object.
   * @param {object} palette raw colors.toml contents (plus optional `name`)
   * @returns {object} resolved surfaces + polarity
   */
  function deriveSurfaces(palette) {
    const p = palette || {};

    const base = pick(p, "background", "dark_background", "darker_background") || "#101418";
    const declaredMode = (p.mode || "").toLowerCase();

    // Polarity from the actual background luminance, not the label.
    const bgLum = C.relLuminance(base);
    const isNight = bgLum < 0.5;
    const polarity = isNight ? "dark" : "light";

    // Anchor text/accent ahead of building the ladder.
    let fg = pick(p, "foreground", "bright_foreground") || C.readableOn(base);
    let accent = pick(p, "accent", "blue", "cyan", "color4", "color6") ||
      (isNight ? "#6aa9ff" : "#1e5fb4");

    // Ensure body text is readable on the base surface.
    if (C.contrast(fg, base) < MIN_TEXT_CONTRAST) {
      fg = C.readableOn(base, "#f2f2f2", "#141414");
    }

    // Build the elevation ladder. For a dark theme, "raised" is lighter and
    // "sunken" is darker; for a light theme the direction flips.
    const towardFg = (t) => C.toward(base, fg, t);

    const surfaces = isNight
      ? {
          bgDeep: C.darken(base, 0.45),
          bgSunken: C.darken(base, 0.25),
          bg: base,
          bgRaise: towardFg(0.06),
          bgRaise2: towardFg(0.11),
          border: towardFg(0.16),
          borderStrong: towardFg(0.28),
        }
      : {
          bgDeep: C.lighten(base, 0.35),
          bgSunken: C.darken(base, 0.05),
          bg: base,
          bgRaise: C.lighten(base, 0.5),
          bgRaise2: C.lighten(base, 0.72),
          border: C.darken(base, 0.14),
          borderStrong: C.darken(base, 0.28),
        };

    // Accent must be legible as a link color on the base.
    let accentFg = accent;
    if (C.contrast(accentFg, base) < 3) {
      accentFg = isNight ? C.lighten(accent, 0.35) : C.darken(accent, 0.25);
    }

    // Dim text: keeps readable-ish but de-emphasized.
    let fgDim = pick(p, "dark_foreground", "muted") || C.toward(fg, base, 0.4);
    if (C.contrast(fgDim, base) < 3) fgDim = C.toward(fg, base, 0.28);

    const muted = pick(p, "muted") || surfaces.border;
    const selection = pick(p, "selection") || C.toward(accent, base, 0.6);

    return {
      name: p.name || "unknown",
      found: p.found !== false,
      isNight,
      polarity,
      declaredMode,
      luminance: Number(bgLum.toFixed(4)),
      bg: surfaces.bg,
      bgDeep: surfaces.bgDeep,
      bgSunken: surfaces.bgSunken,
      bgRaise: surfaces.bgRaise,
      bgRaise2: surfaces.bgRaise2,
      border: surfaces.border,
      borderStrong: surfaces.borderStrong,
      fg,
      fgBright: pick(p, "bright_foreground") || fg,
      fgDim,
      accent: accentFg,
      accentRaw: accent,
      selection,
      muted,
      onAccent: C.readableOn(accentFg, "#ffffff", "#0b0b0b"),
      ansi: {
        // Named semantic keys win; fall back to the color0..15 ansi slots some
        // themes ship instead (color1=red, color2=green, ... per ANSI order).
        red: pick(p, "red", "color1") || "#e5484d",
        green: pick(p, "green", "color2") || "#46a758",
        yellow: pick(p, "yellow", "color3") || "#e0a000",
        blue: pick(p, "blue", "color4") || "#4a90d9",
        magenta: pick(p, "magenta", "color5") || "#d6409f",
        cyan: pick(p, "cyan", "color6") || "#00a2c7",
        orange: pick(p, "orange", "color9", "color3") || "#f76b15",
        brown: pick(p, "brown", "color9") || "#8a6a4a",
      },
      contrast: {
        fgOnBg: Number(C.contrast(fg, base).toFixed(2)),
        accentOnBg: Number(C.contrast(accentFg, base).toFixed(2)),
      },
    };
  }

  globalThis.OmarchySurfaces = { deriveSurfaces, MIN_TEXT_CONTRAST };
})();
