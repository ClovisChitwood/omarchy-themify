// Tests for the color/contrast helpers and the surface ladder.
// Run: node test-surfaces.js

const fs = require("fs");
for (const f of ["omarchy-colors.js", "omarchy-surfaces.js"]) {
  eval(fs.readFileSync(f, "utf8"));
}
const C = globalThis.OmarchyColors;
const { deriveSurfaces } = globalThis.OmarchySurfaces;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS - " + name); }
  else { fail++; console.log("FAIL - " + name + (detail ? "  (" + detail + ")" : "")); }
}

// ---- WCAG helpers -----------------------------------------------------------

check("luminance(black) == 0", Math.abs(C.relLuminance("#000000")) < 1e-9);
check("luminance(white) == 1", Math.abs(C.relLuminance("#ffffff") - 1) < 1e-9);
check("contrast(black,white) == 21", Math.abs(C.contrast("#000000", "#ffffff") - 21) < 0.01,
  "got " + C.contrast("#000000", "#ffffff"));
check("contrast symmetric", C.contrast("#123456", "#abcdef") === C.contrast("#abcdef", "#123456"));
check("parseHex shorthand", JSON.stringify(C.parseHex("#abc")) === JSON.stringify({ r: 0xaa, g: 0xbb, b: 0xcc }));
check("parseHex rejects junk", C.parseHex("nope") === null);
check("mix endpoints", C.mix("#000000", "#ffffff", 0) === "#000000" && C.mix("#000000", "#ffffff", 1) === "#ffffff");
check("mix midpoint", C.mix("#000000", "#ffffff", 0.5) === "#808080", C.mix("#000000", "#ffffff", 0.5));
check("readableOn dark bg picks light", C.readableOn("#101418") === "#ffffff");
check("readableOn light bg picks dark", C.readableOn("#fafafa") === "#000000");

// ---- dark theme ladder ------------------------------------------------------

const retro = {
  name: "retro-82", found: true, mode: "dark",
  accent: "#faa968", selection: "#134e5a", muted: "#2a6b78",
  background: "#05182e", dark_background: "#031222", darker_background: "#020c17",
  lighter_background: "#0a2540", foreground: "#f6dcac", dark_foreground: "#3f8f8a",
  bright_foreground: "#f6dcac", red: "#f85525", green: "#028391", yellow: "#e97b3c",
  blue: "#3f8f8a", cyan: "#8cbfb8", magenta: "#3f8f8a", orange: "#faa968",
};
const d = deriveSurfaces(retro);

check("dark theme -> isNight", d.isNight === true);
check("dark theme -> polarity dark", d.polarity === "dark");
check("dark: raised is lighter than base", C.relLuminance(d.bgRaise) > C.relLuminance(d.bg));
check("dark: deep is darker than base", C.relLuminance(d.bgDeep) < C.relLuminance(d.bg));
check("dark: text contrast >= 4.5", C.contrast(d.fg, d.bg) >= 4.5,
  "got " + C.contrast(d.fg, d.bg).toFixed(2));
check("dark: accent contrast >= 3", C.contrast(d.accent, d.bg) >= 3,
  "got " + C.contrast(d.accent, d.bg).toFixed(2));
check("dark: onAccent readable on accent", C.contrast(d.accent, d.onAccent) >= 4.5,
  "got " + C.contrast(d.accent, d.onAccent).toFixed(2));
check("dark: ansi colors carried through", d.ansi.red === "#f85525" && d.ansi.green === "#028391");

// ---- LIGHT polarity from a MISLABELED theme --------------------------------
// The whole point of luminance-over-label: a theme named/set to "day" that
// actually ships a dark palette must still be treated as night.
const mislabeled = { mode: "day", name: "midnight-day", background: "#0b0b0b",
  foreground: "#eeeeee", accent: "#88aaff", muted: "#555555" };
const m = deriveSurfaces(mislabeled);
check("mislabeled 'day' w/ dark bg -> isNight", m.isNight === true, "polarity=" + m.polarity);
check("mislabeled -> polarity dark despite mode=day", m.polarity === "dark");
check("mislabeled -> declaredMode still reported", m.declaredMode === "day");

const mislabeled2 = { mode: "night", name: "snow-night", background: "#fdf6e3",
  foreground: "#222222", accent: "#1e5fb4", muted: "#999999" };
const m2 = deriveSurfaces(mislabeled2);
check("mislabeled 'night' w/ light bg -> polarity light", m2.polarity === "light", "polarity=" + m2.polarity);

// ---- light theme ladder -----------------------------------------------------

const light = { name: "flexoki-light", found: true, mode: "light", accent: "#af3029",
  background: "#fffcf0", darker_background: "#f2f0e5", foreground: "#100f0f",
  bright_foreground: "#100f0f", muted: "#878580", selection: "#e6e4d9",
  dark_foreground: "#6f6e69", cyan: "#24837b" };
const l = deriveSurfaces(light);

check("light theme -> polarity light", l.polarity === "light");
check("light: raised is lighter than base", C.relLuminance(l.bgRaise) > C.relLuminance(l.bg));
check("light: deep is lighter than base (not darker)", C.relLuminance(l.bgDeep) > C.relLuminance(l.bg),
  "deep lum " + C.relLuminance(l.bgDeep).toFixed(3) + " vs base " + C.relLuminance(l.bg).toFixed(3));
check("light: text contrast >= 4.5", C.contrast(l.fg, l.bg) >= 4.5, "got " + C.contrast(l.fg, l.bg).toFixed(2));

// ---- colorN-only theme (no named keys, no mode) -----------------------------
// Some themes (retro PC palettes) ship only accent/selection/background/
// foreground + color0..15, with no `mode` at all. Polarity must come from
// luminance and the ansi colors must resolve from the colorN slots.
const retropc = {
  name: "retropc", found: true,
  accent: "#cc9900", selection: "#2a1f00", background: "#0a0a08", foreground: "#ffb000",
  color0: "#0a0a08", color1: "#ff8800", color2: "#ffcc00", color3: "#ffd700",
  color4: "#cc9900", color5: "#ff9900", color6: "#cc9900", color7: "#ffb000",
  color8: "#805500", color9: "#ffaa00", color10: "#ffcc00", color11: "#ffdd00",
  color12: "#ffbb00", color13: "#ffaa00", color14: "#ffb000", color15: "#ffcc00",
};
const r = deriveSurfaces(retropc);
check("colorN theme (no mode) -> polarity dark from luminance", r.polarity === "dark", r.polarity);
check("colorN theme -> declaredMode empty", r.declaredMode === "");
check("colorN theme -> ansi red from color1", r.ansi.red === "#ff8800", r.ansi.red);
check("colorN theme -> ansi green from color2", r.ansi.green === "#ffcc00", r.ansi.green);
check("colorN theme -> ansi blue from color4", r.ansi.blue === "#cc9900", r.ansi.blue);
check("colorN theme -> accent used", r.accentRaw === "#cc9900");
check("colorN theme -> text contrast ok", C.contrast(r.fg, r.bg) >= 4.5, C.contrast(r.fg, r.bg).toFixed(2));

// ---- hex -> HSL (X's tokens are HSL component triples) ---------------------

check("hslTriple(white)", C.hslTriple("#ffffff") === "0 0% 100%", C.hslTriple("#ffffff"));
check("hslTriple(black)", C.hslTriple("#000000") === "0 0% 0%", C.hslTriple("#000000"));
check("hslTriple(red)", C.hslTriple("#ff0000") === "0 100% 50%", C.hslTriple("#ff0000"));
check("hslTriple(green)", C.hslTriple("#00ff00") === "120 100% 50%", C.hslTriple("#00ff00"));
check("hslTriple(blue)", C.hslTriple("#0000ff") === "240 100% 50%", C.hslTriple("#0000ff"));
check("hslTriple output parses as a CSS hsl() triple",
  /^\d{1,3} \d{1,3}% \d{1,3}%$/.test(C.hslTriple(retro.accent)), C.hslTriple(retro.accent));
check("hslTriple rejects junk", C.hslTriple("nope") === null);
{
  // round-trip: converting the triple back to rgb should land near the source
  const t = C.hexToHsl("#cc9900");
  check("hexToHsl keeps hue family (amber ~45deg)", t.h >= 43 && t.h <= 47, "h=" + t.h);
  check("hexToHsl saturation sane", t.s > 90, "s=" + t.s);
}

// ---- degenerate input survives ---------------------------------------------

const empty = deriveSurfaces({});
check("empty palette -> no throw, has colors", !!empty.bg && !!empty.fg && !!empty.accent);
check("empty palette -> valid polarity", empty.polarity === "dark" || empty.polarity === "light");
const garbage = deriveSurfaces({ background: "not-a-color", foreground: "###", accent: "" });
check("garbage input -> falls back to usable bg", C.parseHex(garbage.bg) !== null, "bg=" + garbage.bg);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
