// Tests for the MAIN-world prefers-color-scheme override.
// Run: node test-polyfill.js
//
// Node has EventTarget/Event globally, so we only need to mock window,
// document, localStorage and MutationObserver.

const fs = require("fs");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS - " + name); }
  else { fail++; console.log("FAIL - " + name + (detail ? "  (" + detail + ")" : "")); }
}

function makeEnv({ stored = null, nativeDark = false } = {}) {
  const listeners = {};
  const attrStore = {};
  const lsStore = {};
  if (stored) lsStore["omarchy-themify:scheme"] = stored;

  const mockWindow = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    // native matchMedia: pretend the OS is dark or light
    matchMedia(q) {
      const ql = String(q).toLowerCase();
      const matches = ql.includes("dark") ? nativeDark : !nativeDark;
      return {
        media: q, matches,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {},
      };
    },
  };

  const documentElement = {
    getAttribute(k) { return k in attrStore ? attrStore[k] : null; },
    setAttribute(k, v) { attrStore[k] = v; },
  };

  const docListeners = {};
  const document = {
    documentElement,
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  };

  const observers = [];
  class MutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() {}
  }

  const localStorage = {
    getItem(k) { return k in lsStore ? lsStore[k] : null; },
    setItem(k, v) { lsStore[k] = String(v); },
  };

  global.window = mockWindow;
  global.document = document;
  global.localStorage = localStorage;
  global.MutationObserver = MutationObserver;

  function fireMessage(data) {
    for (const fn of listeners["message"] || []) {
      fn({ source: mockWindow, data });
    }
  }
  function fireAttrObserver() { for (const o of observers) o.cb([]); }

  return { mockWindow, attrStore, lsStore, fireMessage, fireAttrObserver, documentElement, observers };
}

// ---- 1. cold start, OS dark, no stored value --------------------------------
{
  const env = makeEnv({ stored: null, nativeDark: true });
  delete globalThis.__omarchyThemifyMatchMedia; // allow re-install
  eval(fs.readFileSync("inject-prefers-color-scheme.js", "utf8"));
  const mm = global.window.matchMedia;

  check("cold start: non-scheme query delegates to native",
    mm("(min-width: 600px)").media === "(min-width: 600px)");
  check("cold start: scheme query falls back to OS value (dark)",
    mm("(prefers-color-scheme: dark)").matches === true);
  check("cold start: no localStorage write yet",
    env.lsStore["omarchy-themify:scheme"] === undefined);
}

// ---- 2. content script says dark, OS is light -------------------------------
{
  const env = makeEnv({ stored: null, nativeDark: false });
  delete globalThis.__omarchyThemifyMatchMedia;
  eval(fs.readFileSync("inject-prefers-color-scheme.js", "utf8"));
  const mm = global.window.matchMedia;

  const qDark = mm("(prefers-color-scheme: dark)");
  check("before message: dark query false (OS light)", qDark.matches === false);

  let fired = 0, lastMatches = null, onchangeCalls = 0;
  qDark.addEventListener("change", (e) => { fired++; lastMatches = qDark.matches; });
  qDark.onchange = () => { onchangeCalls++; };

  env.fireMessage({ __omarchyThemifyScheme: "dark" });

  check("after message: dark query true", qDark.matches === true, "matches=" + qDark.matches);
  check("after message: light query false", mm("(prefers-color-scheme: light)").matches === false);
  check("change event fired on tracked MQL", fired === 1, "fired=" + fired);
  check("event.matches snapshot true", lastMatches === true);
  check("onchange property invoked", onchangeCalls === 1, "calls=" + onchangeCalls);
  check("scheme persisted to localStorage", env.lsStore["omarchy-themify:scheme"] === "dark");
}

// ---- 3. no duplicate change on same value ----------------------------------
{
  const env = makeEnv({ stored: null, nativeDark: false });
  delete globalThis.__omarchyThemifyMatchMedia;
  eval(fs.readFileSync("inject-prefers-color-scheme.js", "utf8"));
  const q = global.window.matchMedia("(prefers-color-scheme: dark)");
  let fired = 0;
  q.addEventListener("change", () => fired++);
  env.fireMessage({ __omarchyThemifyScheme: "dark" });
  env.fireMessage({ __omarchyThemifyScheme: "dark" }); // same value again
  check("idempotent: repeated same scheme fires once", fired === 1, "fired=" + fired);
  env.fireMessage({ __omarchyThemifyScheme: "light" });
  check("flip to light fires again", fired === 2, "fired=" + fired);
  check("flip: dark query now false", q.matches === false);
}

// ---- 4. stored value wins at boot (repeat visit) ---------------------------
{
  const env = makeEnv({ stored: "dark", nativeDark: false }); // OS light, theme dark
  delete globalThis.__omarchyThemifyMatchMedia;
  eval(fs.readFileSync("inject-prefers-color-scheme.js", "utf8"));
  const q = global.window.matchMedia("(prefers-color-scheme: dark)");
  check("stored scheme applied at boot, before any message", q.matches === true, "matches=" + q.matches);
}

// ---- 5. attribute safety net ------------------------------------------------
{
  const env = makeEnv({ stored: null, nativeDark: false });
  delete globalThis.__omarchyThemifyMatchMedia;
  eval(fs.readFileSync("inject-prefers-color-scheme.js", "utf8"));
  const q = global.window.matchMedia("(prefers-color-scheme: dark)");
  let fired = 0;
  q.addEventListener("change", () => fired++);
  env.documentElement.setAttribute("data-omarchy-scheme", "dark");
  env.fireAttrObserver();
  check("attribute + MutationObserver applies scheme", q.matches === true);
  check("attribute path fired change", fired === 1, "fired=" + fired);
}

// ---- 6. legacy addListener/removeListener ----------------------------------
{
  const env = makeEnv({ stored: null, nativeDark: false });
  delete globalThis.__omarchyThemifyMatchMedia;
  eval(fs.readFileSync("inject-prefers-color-scheme.js", "utf8"));
  const q = global.window.matchMedia("(prefers-color-scheme: dark)");
  let n = 0;
  const cb = () => n++;
  q.addListener(cb);
  env.fireMessage({ __omarchyThemifyScheme: "dark" });
  check("legacy addListener receives change", n === 1, "n=" + n);
  q.removeListener(cb);
  env.fireMessage({ __omarchyThemifyScheme: "light" });
  check("legacy removeListener stops it", n === 1, "n=" + n);
}

// ---- 7. bare query without dark/light is left alone ------------------------
{
  const env = makeEnv({ stored: null, nativeDark: false });
  delete globalThis.__omarchyThemifyMatchMedia;
  eval(fs.readFileSync("inject-prefers-color-scheme.js", "utf8"));
  const q = global.window.matchMedia("(prefers-color-scheme: no-preference)");
  check("no-preference query delegates to native", q.constructor.name !== "SchemeMQL",
    "constructor=" + q.constructor.name);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
