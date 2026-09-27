// Real-browser E2E for the low-contrast text repair.
//
// Unit tests prove the colour maths; this proves the DOM behaviour on rendered
// pages, which is the part that can only be validated in a browser: reading the
// *composited* background up the ancestor chain, skipping text over photos and
// gradient headlines, repairing dynamic content, and restoring the page's own
// colours when the theme is switched off.
//
// It launches a throwaway headless Chromium, injects the real content scripts
// (with a stubbed chrome.runtime) into fixtures/contrast.html, and asserts on
// computed styles with an INDEPENDENT WCAG implementation — not the module's own
// helpers, so a bug in those cannot hide behind them.
//
// Run: node test-contrast-e2e.js

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 8731;
const CDP_PORT = 9333;
const ROOT = __dirname;
const MODULES = ["omarchy-colors.js", "omarchy-surfaces.js", "omarchy-sites.js", "omarchy-contrast.js", "content.js"];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS - " + name); }
  else { fail++; console.log("FAIL - " + name + (detail ? "  (" + detail + ")" : "")); }
}

// The palette the fixture is themed with (a stock dark Omarchy theme).
const PALETTE = {
  name: "retro-82", found: true, mode: "dark",
  accent: "#faa968", selection: "#134e5a", muted: "#2a6b78",
  background: "#05182e", dark_background: "#031222", darker_background: "#020c17",
  lighter_background: "#0a2540", foreground: "#f6dcac", dark_foreground: "#3f8f8a",
  bright_foreground: "#f6dcac", red: "#f85525", green: "#028391", yellow: "#e97b3c",
  blue: "#3f8f8a", cyan: "#8cbfb8", magenta: "#3f8f8a", orange: "#faa968",
};

// ---------------------------------------------------------------------------
// page-side harness (runs in the browser)
// ---------------------------------------------------------------------------

const HARNESS = `
window.__htmlAtStart = !!document.documentElement;   // document_start edge case
window.__themifyPalette = ${JSON.stringify(PALETTE)};
window.__themifyHandlers = [];
window.chrome = {
  runtime: {
    sendMessage(msg, cb) { if (cb) cb({ palette: window.__themifyPalette, enabled: true, repair: true }); },
    onMessage: { addListener(h) { window.__themifyHandlers.push(h); } },
    lastError: undefined,
  },
};
window.__sendPalette = (opts) => {
  const msg = Object.assign({ type: "omarchy-themify:palette", palette: window.__themifyPalette, enabled: true, repair: true }, opts || {});
  window.__themifyHandlers.forEach((h) => h(msg, null, () => {}));
};
window.__stats = () => window.OmarchyContrast.stats();
window.__addDynamic = () => {
  const d = document.createElement("div");
  d.id = "dyn";
  d.setAttribute("style", "color:#2b2b2b");
  d.textContent = "content that arrived after load";
  document.body.insertBefore(d, document.body.firstChild);
};
`;

// Independent WCAG maths + background walk (deliberately NOT the module's code).
const ASSERTIONS = `
(() => {
  function toRgb(str) {
    const m = String(str).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(c) { return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); }
  function ratio(a, b) {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function blend(fg, bg) {
    const a = fg.a == null ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
  }
  function effBg(el) {
    const chain = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      const c = toRgb(cs.backgroundColor);
      if (c && c.a > 0) { chain.push(c); if (c.a >= 1) break; }
      node = node.parentElement;
    }
    let acc = { r: 255, g: 255, b: 255 };
    for (let i = chain.length - 1; i >= 0; i--) acc = blend(chain[i], acc);
    return acc;
  }
  function info(id) {
    const el = document.getElementById(id);
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    const bg = effBg(el);
    const raw = toRgb(cs.color);
    // Translucent ink: judge what is actually painted, not the alpha-less colour.
    const fg = raw && bg ? blend(raw, bg) : raw;
    return {
      attr: el.hasAttribute("data-om-themify-contrast"),
      color: cs.color,
      inline: el.style.getPropertyValue("color"),
      bg: bg ? "rgb(" + Math.round(bg.r) + ", " + Math.round(bg.g) + ", " + Math.round(bg.b) + ")" : null,
      ratio: bg && fg ? ratio(fg, bg) : null,
      alpha: raw ? raw.a : null,
    };
  }
  const ids = ["stale","inheritSpan","whiteCard","fine","photo","onPanel","srOnly","gradientText",
               "ariaHidden","optOut","dimAlpha","bigStale","buttonStale","link","bottomStale"];
  const out = {};
  for (const id of ids) out[id] = info(id);
  out.__attrCount = document.querySelectorAll("[data-om-themify-contrast]").length;
  out.__hasThemeStyle = !!document.getElementById("omarchy-themify-style");
  out.__omBg = getComputedStyle(document.documentElement).getPropertyValue("--om-bg").trim();
  out.__bodyBg = getComputedStyle(document.body).backgroundColor;
  out.__htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  out.__stats = window.__stats();
  out.__htmlAtStart = window.__htmlAtStart;
  return out;
})()
`;

// ---------------------------------------------------------------------------
// server + browser plumbing
// ---------------------------------------------------------------------------

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "fixtures/contrast.html";
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end("nope"); return; }
      res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html" });
      res.end(fs.readFileSync(file));
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(binary, extra) {
  return spawn(binary, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=900,620",
    "--remote-allow-origins=*",
    "--remote-debugging-port=" + CDP_PORT,
    "--user-data-dir=" + path.join(require("os").tmpdir(), "themify-e2e-" + process.pid),
    "about:blank",
    ...(extra || []),
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

async function waitForCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(250);
  }
  return null;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.addEventListener("error", reject);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    });
  });
}

async function main() {
  if (!fs.existsSync("/usr/bin/chromium")) { console.log("SKIP - /usr/bin/chromium not present"); process.exit(0); }
  const server = await serve();
  const chrome = launch("/usr/bin/chromium");
  const wsUrl = await waitForCdp(15000);
  if (!wsUrl) {
    chrome.kill("SIGKILL");
    console.log("FAIL - headless chromium did not expose CDP");
    process.exit(1);
  }

  const cdp = await connect(wsUrl);
  const evaluate = async (expr, awaitPromise = false) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
  };

  const scripts = MODULES.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n");
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: HARNESS + "\n" + scripts,
  });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/fixtures/contrast.html` });
  await sleep(1200);

  // ---- phase 1: themed with repair on ------------------------------------
  // No nudging here: the content script must theme the page from its own
  // palette fetch, including when it ran before <html> existed.
  let s = await evaluate(ASSERTIONS);
  console.log(`     (documentElement present at script time: ${s.__htmlAtStart})`);

  check("themed from the content script's own palette fetch (no extra message)",
    s.__hasThemeStyle === true, JSON.stringify({ hasStyle: s.__hasThemeStyle }));
  check("theme applied (--om-bg on :root)", s.__omBg === "#05182e", s.__omBg);
  check("page canvas is the theme's deep background", s.__htmlBg !== "rgba(0, 0, 0, 0)", s.__htmlBg);
  check("reported bug fixed: hardcoded #333 ink made readable",
    s.stale.attr === true && s.stale.ratio >= 4.5,
    JSON.stringify({ attr: s.stale.attr, ratio: s.stale.ratio, color: s.stale.color, bg: s.stale.bg }));
  check("inherited dark ink fixed too",
    s.inheritSpan.attr === true && s.inheritSpan.ratio >= 4.5,
    JSON.stringify({ ratio: s.inheritSpan.ratio, color: s.inheritSpan.color }));
  check("light-on-white card repainted darker",
    s.whiteCard.attr === true && s.whiteCard.ratio >= 4.5,
    JSON.stringify({ ratio: s.whiteCard.ratio, color: s.whiteCard.color }));
  check("hardcoded link colour repaired",
    s.link.attr === true && s.link.ratio >= 4.5, JSON.stringify({ ratio: s.link.ratio, color: s.link.color }));
  check("translucent panel judged by its composite",
    s.onPanel.attr === true && s.onPanel.ratio >= 4.5,
    JSON.stringify({ ratio: s.onPanel.ratio, color: s.onPanel.color, bg: s.onPanel.bg }));
  check("translucent ink held to the softer dim bar",
    s.dimAlpha.attr === true && s.dimAlpha.ratio >= 4.0,
    JSON.stringify({ ratio: s.dimAlpha.ratio, color: s.dimAlpha.color }));
  check("large text only needs 3:1 and gets it",
    s.bigStale.attr === true && s.bigStale.ratio >= 3.0,
    JSON.stringify({ ratio: s.bigStale.ratio, color: s.bigStale.color }));
  check("saturated button text made legible",
    s.buttonStale.attr === true && s.buttonStale.ratio >= 4.5,
    JSON.stringify({ ratio: s.buttonStale.ratio, color: s.buttonStale.color, bg: s.buttonStale.bg }));

  check("readable text left alone", s.fine.attr === false && s.fine.color === "rgb(246, 220, 172)",
    JSON.stringify(s.fine));
  check("text over a gradient left alone (unjudgeable)", s.photo.attr === false, JSON.stringify(s.photo));
  check("screen-reader-only text left alone", s.srOnly.attr === false, JSON.stringify(s.srOnly));
  check("gradient text (background-clip:text) left alone", s.gradientText.attr === false, JSON.stringify(s.gradientText));
  check("aria-hidden text left alone", s.ariaHidden.attr === false, JSON.stringify(s.ariaHidden));
  check("explicit opt-out honoured", s.optOut.attr === false && s.optOut.color === "rgb(26, 26, 26)",
    JSON.stringify(s.optOut));
  check("repaired text keeps a real colour (never transparent)",
    s.stale.alpha === 1 && s.onPanel.alpha === 1,
    JSON.stringify({ stale: s.stale.alpha, panel: s.onPanel.alpha }));

  check("offscreen text is not judged before it scrolls in", s.bottomStale.attr === false,
    JSON.stringify(s.bottomStale));

  // ---- dynamic content + scroll band --------------------------------------
  await evaluate(`window.__addDynamic()`);
  await sleep(400);
  const dyn = await evaluate(`(() => { const el = document.getElementById("dyn");
    const cs = getComputedStyle(el);
    return { attr: el.hasAttribute("data-om-themify-contrast"), inline: el.style.getPropertyValue("color"), color: cs.color }; })()`);
  check("late-arriving content is repaired (MutationObserver)", dyn.attr === true && dyn.inline.length > 0,
    JSON.stringify(dyn));

  await evaluate(`new Promise((r) => { window.scrollTo(0, document.body.scrollHeight); setTimeout(r, 500); })`, true);
  const band = await evaluate(`(() => { const el = document.getElementById("bottomStale");
    const cs = getComputedStyle(el);
    const a = el.hasAttribute("data-om-themify-contrast");
    return { attr: a, color: cs.color }; })()`);
  check("below-the-fold text repaired once scrolled into view", band.attr === true, JSON.stringify(band));

  const stats = await evaluate(`window.__stats()`);
  check("stats report real work", stats.fixed >= 9 && stats.checked >= 10, JSON.stringify(stats));

  // ---- phase 2: repair off ------------------------------------------------
  await evaluate(`new Promise((r) => { window.__sendPalette({ repair: false }); setTimeout(r, 400); })`, true);
  const off = await evaluate(ASSERTIONS);
  check("repair off: every override reverted", off.__attrCount === 0, String(off.__attrCount));
  check("repair off: the page's own inline colour is restored",
    off.stale.color === "rgb(51, 51, 51)" && off.stale.inline.length > 0,
    JSON.stringify({ color: off.stale.color, inline: off.stale.inline }));
  check("repair off: theme itself stays applied", off.__hasThemeStyle === true && off.__omBg === "#05182e");
  check("repair off: ink we never touched is untouched", off.fine.color === "rgb(246, 220, 172)");

  // ---- phase 3: theme off -------------------------------------------------
  await evaluate(`new Promise((r) => { window.__sendPalette({ enabled: false }); setTimeout(r, 300); })`, true);
  const disabled = await evaluate(ASSERTIONS);
  check("theme off: injected stylesheet removed", disabled.__hasThemeStyle === false);
  check("theme off: no unrepaired overrides left behind", disabled.__attrCount === 0, String(disabled.__attrCount));
  check("theme off: original colours intact", disabled.stale.color === "rgb(51, 51, 51)");

  // ---- phase 4: re-enable is idempotent ----------------------------------
  await evaluate(`new Promise((r) => { window.scrollTo(0, 0); setTimeout(() => { window.__sendPalette(); setTimeout(r, 600); }, 100); })`, true);
  const again = await evaluate(ASSERTIONS);
  check("re-enable: repair runs again", again.stale.attr === true && again.stale.ratio >= 4.5, JSON.stringify(again.stale));
  check("re-enable: exactly one stylesheet", await evaluate(`document.querySelectorAll("#omarchy-themify-style").length === 1`));
  check("re-enable: every marked element really is repaired",
    again.__attrCount >= 8 &&
    ["stale", "inheritSpan", "whiteCard", "onPanel", "dimAlpha", "bigStale", "buttonStale", "link"]
      .every((id) => again[id] && again[id].attr === true),
    JSON.stringify({ attrCount: again.__attrCount }));

  cdp.close();
  chrome.kill("SIGKILL");
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("E2E error:", e && e.message); process.exit(1); });
