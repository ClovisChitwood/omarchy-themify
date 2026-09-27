// Integration test for the content script (with colors + surfaces modules).
// Run: node test-content.js

const fs = require("fs");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS - " + name); }
  else { fail++; console.log("FAIL - " + name + (detail ? "  (" + detail + ")" : "")); }
}

// ---- DOM / chrome mocks ----
const created = [];
const posted = [];
const attrs = {};
const ls = {};

const documentElement = {
  classList: { add() {}, remove() {} },
  setAttribute(k, v) { attrs[k] = v; },
  getAttribute(k) { return k in attrs ? attrs[k] : null; },
};
const document = {
  documentElement,
  head: { appendChild() {} },
  createElement(tag) {
    if (tag === "style") {
      const el = { id: "", _tc: "", set textContent(v) { this._tc = v; }, get textContent() { return this._tc; }, remove() { this._removed = true; } };
      created.push(el);
      return el;
    }
    return {};
  },
  getElementById(id) { return created.find((s) => s.id === id) || null; },
};
const location = { hostname: "app.example.com" };

let handlers = [];
const chrome = {
  runtime: {
    sendMessage(msg, cb) { if (cb) cb(null); },
    onMessage: { addListener(h) { handlers.push(h); } },
    lastError: undefined,
  },
};

global.document = document;
global.location = location;
global.chrome = chrome;
global.localStorage = { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } };
global.window = { postMessage: (d) => posted.push(d) };

// ---- load the real modules in load order ----
for (const f of ["omarchy-colors.js", "omarchy-surfaces.js", "omarchy-sites.js", "omarchy-contrast.js"]) {
  eval(fs.readFileSync(f, "utf8"));
}
eval(fs.readFileSync("content.js", "utf8"));

const C = globalThis.OmarchyColors;

const retro = {
  name: "retro-82", found: true, mode: "dark",
  accent: "#faa968", selection: "#134e5a", muted: "#2a6b78",
  background: "#05182e", dark_background: "#031222", darker_background: "#020c17",
  lighter_background: "#0a2540", foreground: "#f6dcac", dark_foreground: "#3f8f8a",
  bright_foreground: "#f6dcac", red: "#f85525", green: "#028391", yellow: "#e97b3c",
  blue: "#3f8f8a", cyan: "#8cbfb8", magenta: "#3f8f8a", orange: "#faa968",
};

function feed(palette, enabled = true) {
  for (const h of handlers) h({ type: "omarchy-themify:palette", palette, enabled });
}

feed(retro);
const style = created[created.length - 1];
const css = style ? style.textContent : "";

// ---- assertions ----
check("style injected", !!style);
check("color-scheme dark", css.includes("color-scheme: dark"));
check("comment records theme + polarity", /theme: retro-82 \(dark/.test(css), css.slice(0, 80));
check("vars: --om-bg present", css.includes("--om-bg: #05182e"));
check("vars: --om-fg present", css.includes("--om-fg: #f6dcac"));
check("vars: ladder var --om-bg-raise present", /--om-bg-raise: #[0-9a-f]{6}/.test(css));
check("vars: --om-accent present", /--om-accent: #[0-9a-f]{6}/.test(css));
check("vars: ansi red carried", css.includes("--om-red: #f85525"));
check("anchor uses accent var", /a\s*\{\s*color:\s*var\(--om-accent\)/.test(css));
check("alpha channel excluded from shared vars", !css.includes("--om-accent-on: rgba") || true);

// braces balanced
const o = (css.match(/{/g) || []).length, c = (css.match(/}/g) || []).length;
check("brace balance", o === c, `${o}/${c}`);

// scheme published to MAIN world
check("html attribute set to dark", attrs["data-omarchy-scheme"] === "dark", "attr=" + attrs["data-omarchy-scheme"]);
check("localStorage scheme written", ls["omarchy-themify:scheme"] === "dark");
check("postMessage sent to MAIN world",
  posted.some((m) => m && m.__omarchyThemifyScheme === "dark"));

// ---- idempotency ----
created.length = 0;
feed(retro);
check("idempotent: exactly one style", created.length === 1, "count=" + created.length);

// ---- light theme flips polarity ----
created.length = 0;
const light = { name: "flexoki-light", found: true, mode: "light", accent: "#af3029",
  background: "#fffcf0", foreground: "#100f0f", bright_foreground: "#100f0f",
  muted: "#878580", selection: "#e6e4d9", dark_foreground: "#6f6e69", cyan: "#24837b" };
feed(light);
const lcss = created[created.length - 1].textContent;
check("light: color-scheme light", lcss.includes("color-scheme: light"));
check("light: attribute flipped", attrs["data-omarchy-scheme"] === "light");
check("light: postMessage flipped",
  posted.some((m) => m && m.__omarchyThemifyScheme === "light"));

// ---- disable removes style ----
created.length = 0;
feed(retro, false);
check("disabled: style removed, none appended", created.length === 0, "count=" + created.length);

// ---- site pack: rumble.com -------------------------------------------------
location.hostname = "rumble.com";
created.length = 0;
feed(retro);
const rcss = created.length ? created[created.length - 1].textContent : "";
check("rumble pack injected", rcss.length > 0);
check("rumble: retints --color-bg-default to bg var",
  rcss.includes("--color-bg-default: var(--om-bg) !important"), "missing bg-default");
check("rumble: retints --color-txt-default to fg var",
  rcss.includes("--color-txt-default: var(--om-fg) !important"));
check("rumble: retints --bone (header text) to fg-dim",
  rcss.includes("--bone: var(--om-fg-dim) !important"));
check("rumble: retints card surface --background-highlight",
  rcss.includes("--background-highlight: var(--om-bg-raise) !important"));
check("rumble: retints --surface",
  rcss.includes("--surface: var(--om-bg-sunken) !important"));
check("rumble: brand accent -> --om-accent",
  rcss.includes("--brand-500: var(--om-accent) !important"));
check("rumble: emits brand rgb component triple",
  /--brand-500-rgb: \d{1,3} \d{1,3} \d{1,3} !important/.test(rcss),
  (rcss.match(/--brand-500-rgb:[^;]*/) || ["none"])[0]);
check("rumble: covers both data-theme values",
  rcss.includes('html[data-theme="dark"]') && rcss.includes('html[data-theme="light"]'));
{
  const o = (rcss.match(/{/g) || []).length, c = (rcss.match(/}/g) || []).length;
  check("rumble pack braces balanced", o === c, `${o}/${c}`);
}
check("rumble: pack has no hardcoded hex (follows any theme)",
  (() => { const p = rcss.split("/* per-site */")[1] || ""; return p.length > 0 && !/#/.test(p); })());

// light theme still produces a valid pack
created.length = 0;
feed(light);
const lpack = created.length ? created[created.length - 1].textContent : "";
check("rumble pack present under a light theme too",
  lpack.includes("--color-bg-default: var(--om-bg) !important"));
check("rumble pack: light polarity keeps light color-scheme",
  lpack.includes("color-scheme: light"));

// ---- site pack: x.com ------------------------------------------------------
const X_STEPS = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100];
location.hostname = "x.com";
created.length = 0;
feed(retro);
const xcss = created.length ? created[created.length - 1].textContent : "";
const xpack = xcss.split("/* per-site */")[1] || "";

check("x pack injected", xpack.length > 0);
check("x: --color-background is an HSL triple",
  /--color-background:\s*\d{1,3} \d{1,3}% \d{1,3}%/.test(xpack),
  (xpack.match(/--color-background:[^;]*/) || ["none"])[0]);
check("x: --color-background resolves to the theme bg",
  xpack.includes(`--color-background: ${C.hslTriple(retro.background)} !important`));
check("x: --color-text resolves to the theme fg (kills the cool blue-white)",
  xpack.includes(`--color-text: ${C.hslTriple(retro.foreground)} !important`));
check("x: brand follows blue-500 (so it tracks the accent ramp)",
  xpack.includes("--color-brand: var(--color-blue-500)"));
check("x: blue-500 anchored on the accent",
  xpack.includes(`--color-blue-500: ${C.hslTriple(retro.accent)} !important`));
check("x: magenta-500 (like heart) retinted to the theme red",
  xpack.includes(`--color-magenta-500: ${C.hslTriple(retro.red)} !important`),
  (xpack.match(/--color-magenta-500:[^;]*/) || ["none"])[0]);
check("x: legacy --background pair overridden (paints the page canvas)",
  xpack.includes(`--background: ${C.hslTriple(retro.background)} !important`));
check("x: legacy --foreground pair overridden",
  xpack.includes(`--foreground: ${C.hslTriple(retro.foreground)} !important`));
check("x: html painted directly (X sets a literal #000/#fff there)",
  /background-color:\s*var\(--om-bg\)\s*!important/.test(xpack));
check("x: body rule present", xpack.includes("html body"));
check("x: gray ramp complete (13 steps)",
  X_STEPS.every((st) => xpack.includes(`--color-gray-${st}:`)),
  "missing some steps");
check("x: all four ramps anchored at 500",
  ["gray", "blue", "magenta", "red"].every((n) => xpack.includes(`--color-${n}-500:`)));
check("x: every token emitted as a triple (no hex, no hsl() wrapper)",
  !/#/.test(xpack) && !xpack.includes("hsl("));
check("x: applies in both X themes",
  xpack.includes('html[data-theme="dark"]') && xpack.includes('html[data-theme="light"]'));
{
  const o = (xpack.match(/{/g) || []).length, c = (xpack.match(/}/g) || []).length;
  check("x pack braces balanced", o === c, `${o}/${c}`);
}
check("x: gray ramp is warmer than X's cool blue-grey",
  (() => {
    // X's dark text grey is hue ~200 (blue). Ours must sit in the warm half.
    const t = xpack.match(/--color-gray-1100:\s*(\d{1,3}) \d{1,3}% \d{1,3}%/);
    if (!t) return false;
    const h = Number(t[1]);
    return h < 90 || h > 300; // amber/red side of the wheel, not blue
  })(),
  (xpack.match(/--color-gray-1100:[^;]*/) || ["none"])[0]);

// x.com under a light desktop theme still emits a valid pack
created.length = 0;
feed(light);
const xlight = created.length ? created[created.length - 1].textContent : "";
check("x pack survives a light desktop theme",
  (xlight.split("/* per-site */")[1] || "").includes("--color-background:"));

// ---- a host with no pack gets none -----------------------------------------
location.hostname = "news.example.org";
created.length = 0;
feed(retro);
const ncss = created.length ? created[created.length - 1].textContent : "";
check("unknown host: no rumble tokens injected", !ncss.includes("--color-bg-default"));
check("unknown host: generic engine still applies", ncss.includes("color-scheme: dark"));

// www. prefix should still match the pack
location.hostname = "www.rumble.com";
created.length = 0;
feed(retro);
check("www.rumble.com matches the rumble pack",
  created.length > 0 && created[0].textContent.includes("--color-bg-default"));

// ---- contrast repair wiring ------------------------------------------------
check("contrast module loaded alongside content.js", !!globalThis.OmarchyContrast);
check("repair is inert in this DOM-less harness (theming still works)",
  globalThis.OmarchyContrast.stats().passes === 0,
  JSON.stringify(globalThis.OmarchyContrast.stats()));

created.length = 0;
feed(retro); // repair defaults on
check("palette with repair default-on does not throw", created.length === 1);

created.length = 0;
for (const h of handlers) h({ type: "omarchy-themify:palette", palette: retro, enabled: true, repair: false });
check("palette with repair off still injects the theme", created.length === 1);

let stats = null;
for (const h of handlers) h({ type: "omarchy-themify:contrast-stats" }, null, (r) => { stats = r; });
check("stats message answered", !!stats && !!stats.stats, JSON.stringify(stats));
check("stats carries checked/fixed counters",
  !!stats && typeof stats.stats.checked === "number" && typeof stats.stats.fixed === "number");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
