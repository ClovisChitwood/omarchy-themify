// Tests for the low-contrast text repair (omarchy-contrast.js).
//
// The color maths is pure, so it runs under plain Node with no DOM. The DOM walk
// (effective background compositing, candidate collection, revert) is covered by
// the real-browser E2E fixture in test-contrast-e2e.js.
//
// Run: node test-contrast.js

const fs = require("fs");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS - " + name); }
  else { fail++; console.log("FAIL - " + name + (detail ? "  (" + detail + ")" : "")); }
}
function near(a, b, eps = 0.05) { return Math.abs(a - b) <= eps; }

// omarchy-contrast.js touches no DOM at load time; it only needs the helpers.
eval(fs.readFileSync("omarchy-colors.js", "utf8"));
eval(fs.readFileSync("omarchy-contrast.js", "utf8"));

const C = globalThis.OmarchyColors;
const X = globalThis.OmarchyContrast;
const { parseColor, over, mixRgb, repair, bestPole, polesFor } = X;

// ---- parseColor -----------------------------------------------------------

check("parse: hex", (() => { const c = parseColor("#336699"); return c.r === 0x33 && c.g === 0x66 && c.b === 0x99 && c.a === 1; })());
check("parse: short hex", (() => { const c = parseColor("#333"); return c.r === 0x33 && c.a === 1; })());
check("parse: rgb()", (() => { const c = parseColor("rgb(51, 51, 51)"); return c.r === 51 && c.g === 51 && c.b === 51 && c.a === 1; })());
check("parse: rgba() keeps alpha", near(parseColor("rgba(10, 20, 30, 0.4)").a, 0.4));
check("parse: modern slash syntax", near(parseColor("rgb(10 20 30 / 0.5)").a, 0.5));
check("parse: percent channel", parseColor("rgb(100% 0% 0%)").r === 255 || near(parseColor("rgb(100% 0% 0%)").r, 255));
check("parse: transparent -> alpha 0", parseColor("transparent").a === 0);
check("parse: color(srgb …) unsupported -> null", parseColor("color(srgb 0.1 0.2 0.3)") === null);
check("parse: var() unresolved -> null", parseColor("var(--whatever)") === null);
check("parse: garbage -> null", parseColor("not-a-color") === null);

// ---- compositing / mixing -------------------------------------------------

const c_over = over({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255 });
check("over: 50% black on white = mid grey", near(c_over.r, 127.5) && near(c_over.g, 127.5));
check("over: opaque fg ignores bg", over({ r: 10, g: 20, b: 30, a: 1 }, { r: 255, g: 255, b: 255 }).r === 10);
check("over: fully transparent fg = bg", over({ r: 10, g: 20, b: 30, a: 0 }, { r: 9, g: 9, b: 9 }).r === 9);
check("mixRgb: t=0 is a, t=1 is b",
  mixRgb({ r: 0, g: 0, b: 0 }, { r: 100, g: 100, b: 100 }, 0).r === 0 &&
  mixRgb({ r: 0, g: 0, b: 0 }, { r: 100, g: 100, b: 100 }, 1).r === 100);
check("bestPole: dark bg -> white", bestPole({ r: 5, g: 24, b: 46 }).r === 255);
check("bestPole: light bg -> black", bestPole({ r: 255, g: 252, b: 240 }).r === 0);

// ---- repair: the actual bug ----------------------------------------------

const darkBg = { r: 0x05, g: 0x18, b: 0x2e };   // a dark desktop-theme canvas
const staleInk = parseColor("#333333");         // hardcoded dark grey from an email

check("baseline: #333 on dark bg really is unreadable",
  C.contrast("#333333", "#05182e") < 4.5,
  String(C.contrast("#333333", "#05182e")));

const fixed = repair(staleInk, darkBg, X.MIN_NORMAL, [bestPole(darkBg)]);
check("repair: fires on failing text", !!fixed);
check("repair: result passes the bar", fixed && fixed.ratio >= X.MIN_NORMAL,
  fixed && String(fixed.ratio));
check("repair: nudge, not a sledgehammer (keeps it near the threshold)",
  fixed && fixed.ratio < X.MIN_NORMAL + 1.2, fixed && String(fixed.ratio));
check("repair: hue preserved (grey in, grey out)",
  fixed && Math.abs(fixed.color.r - fixed.color.g) <= 3 && Math.abs(fixed.color.g - fixed.color.b) <= 3,
  fixed && JSON.stringify(fixed.color));
check("repair: t is fractional (partial move)", fixed && fixed.t > 0 && fixed.t < 1, fixed && String(fixed.t));

// passing text is never touched
const ok = repair({ r: 0xf6, g: 0xdc, b: 0xac }, darkBg, X.MIN_NORMAL, [bestPole(darkBg)]);
check("repair: already-readable text returns null (no touch)", ok === null);

// light polarity: white ink on a white card must go darker, not lighter
const lightBg = { r: 255, g: 252, b: 240 };
const lightFixed = repair(parseColor("#f7f7f7"), lightBg, X.MIN_NORMAL, [bestPole(lightBg)]);
check("repair: light site darkened to readable", lightFixed && lightFixed.ratio >= X.MIN_NORMAL);
check("repair: light fix moves toward black", lightFixed && lightFixed.color.r < 120,
  lightFixed && JSON.stringify(lightFixed.color));

// A pole list that cannot reach the bar: best effort, flagged capped. (With the
// pure white/black pole always in play one of them always clears 4.5:1, so this
// exercises the fallback directly.)
const orangeBg = { r: 0xf7, g: 0x6b, b: 0x15 };
const capped = repair(parseColor("#f97f2f"), orangeBg, X.MIN_NORMAL, [{ r: 0x88, g: 0x88, b: 0x88 }]);
check("repair: unusable pole still lands on the best available colour and flags capped",
  capped && capped.capped === true && capped.t === 1,
  capped && JSON.stringify({ hex: capped.hex, capped: capped.capped }));

const orangeFixed = repair(parseColor("#f97f2f"), orangeBg, X.MIN_NORMAL, [bestPole(orangeBg)]);
check("repair: orange-on-orange button text is made legible",
  orangeFixed && orangeFixed.ratio >= X.MIN_NORMAL && orangeFixed.color.r > orangeFixed.color.b,
  orangeFixed && JSON.stringify({ hex: orangeFixed.hex, ratio: orangeFixed.ratio }));

// translucent ink is judged by what is actually rendered
const dim = repair(over(parseColor("rgba(0,0,0,0.55)"), darkBg), darkBg, X.MIN_NORMAL, [bestPole(darkBg)]);
check("repair: translucent black on dark bg is caught", !!dim);

// ---- pole selection follows the theme ------------------------------------

const darkTheme = { polarity: "dark", fg: "#f6dcac", fgBright: "#ffe9c4" };
const lightTheme = { polarity: "light", fg: "#100f0f", fgBright: "#100f0f" };

const dp = polesFor(darkBg, darkTheme);
check("poles: dark theme tries the theme's own text colour first",
  dp.length >= 1 && dp[0].r === 0xff && near(dp[0].g, 0xe9, 1) && dp[0].b === 0xc4,
  JSON.stringify(dp[0]));
check("poles: pure pole kept as fallback", dp.some((p) => p.r === 255 && p.g === 255 && p.b === 255));

const lp = polesFor(lightBg, lightTheme);
check("poles: light theme uses the dark ink first", lp.length >= 1 && lp[0].r === 0x10, JSON.stringify(lp[0]));

// the theme pole must not be offered when it points the wrong way
const badTheme = { polarity: "dark", fg: "#222222" };
const bp = polesFor(darkBg, badTheme);
check("poles: refuses a pole darker than a dark canvas", bp[0].r === 255, JSON.stringify(bp[0]));

// theme-pole fixes carry the theme's cast (the whole point of preferring it)
const tinted = repair(staleInk, darkBg, X.MIN_NORMAL, polesFor(darkBg, darkTheme));
check("repair: theme pole tints the repaired text warm",
  tinted && tinted.color.b < tinted.color.r, tinted && JSON.stringify(tinted.color));

// ---- DOM layer is inert without a real document ---------------------------

check("start() no-ops in a DOM-less environment", X.start({ surfaces: darkTheme }) === false);
check("stop() is safe with nothing running", X.stop() === true);
check("stats() reports counters", (() => {
  const s = X.stats();
  return s && typeof s.checked === "number" && typeof s.fixed === "number";
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
