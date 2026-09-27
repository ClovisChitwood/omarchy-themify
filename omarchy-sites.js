// Omarchy Themify — per-site packs.
//
// The generic engine (content.js) recolors any page safely but generically.
// A "pack" here is a hand-tuned stylesheet for one site that consumes the same
// --om-* variables, so it keeps following every theme without edits.
//
// A pack may be:
//   - a CSS string, or
//   - a function (surfaces, vars) => CSS string, for a little logic.
//
// Add a site by adding one key here (hostname, `www.` stripped, lowercased) and
// nothing else — content.js picks it up automatically.
//
// Prefer retinting the site's OWN design tokens over hand-writing selectors:
// token-based packs survive redesigns far better, because the site keeps using
// its own token names as long as it keeps its design system.

(function () {
  "use strict";

  const C = globalThis.OmarchyColors;

  // Some tokens are consumed as a bare "r g b" component triple
  // (e.g. --brand-500-rgb), not a hex color.
  function rgbTriple(hex) {
    const c = C && C.parseHex(hex);
    return c ? `${c.r} ${c.g} ${c.b}` : null;
  }

  // X's palette ramp steps, from darkest to lightest (its own ordering).
  const X_STEPS = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100];

  // Build a full token ramp from one Omarchy color. X anchors the canonical
  // hue at step 500, darkens below it and lightens above it, so we mirror that.
  // Emits HSL component triples (see hslTriple) because X consumes these as
  // hsl(var(--token)) -- a hex value here would be invalid CSS.
  function xColorRamp(name, base, bg, fg) {
    return X_STEPS.map((step) => {
      let c;
      if (step === 500) c = base;
      else if (step < 500) c = C.mix(base, bg, 0.78 * ((500 - step) / 500));
      else c = C.mix(base, fg, 0.72 * ((step - 500) / 600));
      return `--color-${name}-${step}: ${C.hslTriple(c)} !important;`;
    }).join(" ");
  }

  // A neutral ramp: sweep the page background up to the foreground colour, so
  // X's greys (borders, hover fills, secondary text) take on the theme's warm
  // cast instead of X's cool blue-grey.
  function xGrayRamp(bg, fg) {
    return X_STEPS.map((step) => {
      const t = step / 1100;
      const c = C.mix(bg, fg, 0.08 + 0.92 * t);
      return `--color-gray-${step}: ${C.hslTriple(c)} !important;`;
    }).join(" ");
  }

  const SITES = {
    /**
     * rumble.com — Tailwind (rum-ui) with a published design-token layer.
     *
     * Verified against the live site via CDP: the page background and header
     * both resolve --color-bg-default, body text uses --color-txt-default,
     * the header/nav uses --bone, and card surfaces use
     * --background-highlight. Those come from the site's own stylesheet, so
     * overriding the tokens recolors the whole app at once.
     *
     * Rumble's theme setting ("System Default" by default) follows
     * prefers-color-scheme, which the MAIN-world shim drives — so it goes dark
     * with the desktop. The overrides below apply in either Rumble theme, so it
     * stays themed even with "Light Theme" selected.
     */
    "rumble.com": (s) => {
      const triple = rgbTriple(s.accent);
      return `
  html, html[data-theme], html[data-theme="dark"], html[data-theme="light"] {
    --color-bg-default: var(--om-bg) !important;
    --color-txt-default: var(--om-fg) !important;
    --bone: var(--om-fg-dim) !important;
    --background: var(--om-bg) !important;
    --background-highlight: var(--om-bg-raise) !important;
    --surface: var(--om-bg-sunken) !important;
    --primary: var(--om-fg) !important;
    --secondary: var(--om-fg-dim) !important;
    --brand-500: var(--om-accent) !important;
    ${triple ? `--brand-500-rgb: ${triple} !important;` : ""}
    background-color: var(--om-bg) !important;
    color: var(--om-fg) !important;
  }
      `;
    },

    /**
     * x.com — Tailwind-ish design-token layer (the x-web stylesheet).
     *
     * Verified against abs.twimg.com/x-web/.../styles-*.css: tokens are defined
     * on `:root[data-theme=dark]` / `[data-theme=light]` as **HSL component
     * triples** ("--color-text: 200 7% 91%") and consumed via hsl(var(--tok)),
     * so every override below is a triple generated with hslTriple() — a hex
     * here would be invalid and silently do nothing.
     *
     * Two things made X look "stock" under the generic engine:
     *   - --color-background is pure black and --color-text is a *cool*
     *     blue-white (200 7% 91%), not the theme's warm foreground.
     *   - the accent is --color-brand = var(--color-blue-500): the "For you"
     *     underline, links and verified checkmarks are all that blue.
     * The pink like-heart is --color-magenta-500 (332 95% 54%).
     *
     * X's own theme setting ("Default") resolves through matchMedia, which the
     * MAIN-world shim drives; the overrides apply in either X theme so it stays
     * themed even with an explicit Light/Lights-out choice.
     */
    "x.com": (s) => `
  html, html[data-theme], html[data-theme="dark"], html[data-theme="light"], html[data-theme="dim"] {
    --color-background: ${C.hslTriple(s.bg)} !important;
    --color-text: ${C.hslTriple(s.fg)} !important;
    --color-brand: var(--color-blue-500) !important;
    --color-brand-foreground: ${C.hslTriple(s.onAccent)} !important;
    --color-modal-background: ${C.hslTriple(s.bgRaise)} !important;
    --color-nested-border: ${C.hslTriple(s.border)} !important;
    /* The page canvas uses a SEPARATE legacy --background/--foreground pair on
       body, and html itself is painted with a literal black/white -- overriding
       only the --color-* set leaves the page background stock. */
    --background: ${C.hslTriple(s.bg)} !important;
    --foreground: ${C.hslTriple(s.fg)} !important;
    background-color: var(--om-bg) !important;
    color: var(--om-fg) !important;
    ${xGrayRamp(s.bg, s.fg)}
    ${xColorRamp("blue", s.accent, s.bg, s.fg)}
    ${xColorRamp("magenta", s.ansi.red, s.bg, s.fg)}
    ${xColorRamp("red", s.ansi.red, s.bg, s.fg)}
  }
  html body {
    background-color: var(--om-bg) !important;
    color: var(--om-fg) !important;
  }
    `,
  };

  globalThis.OmarchySites = SITES;
})();
