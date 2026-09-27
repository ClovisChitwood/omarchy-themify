// Live-extension integration check.
//
// Loads the actual unpacked extension in a throwaway headless Chromium and opens
// fixtures/contrast.html. Everything that unit tests and the injected E2E cannot
// cover is exercised here for real: manifest wiring, content-script load order,
// the native host handshake, the palette broadcast, and the repair pass running
// against the *user's actual current theme* (so it must be polarity-agnostic).
//
// SKIPs cleanly when the native host isn't installed for this browser.
//
// Run: node test-live-extension.js [--headed]

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PORT = 8732;
const CDP_PORT = 9334;
const EXT_ID = "doiheolmnhipkonmobdifpcloeehoknb";
const HOST_MANIFEST = path.join(os.homedir(), ".config", "chromium", "NativeMessagingHosts", "com.omarchy.themify.json");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS - " + name); }
  else { fail++; console.log("FAIL - " + name + (detail ? "  (" + detail + ")" : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPORT = `
(() => {
  function toRgb(s) { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(c) { return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); }
  function ratio(a, b) { const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
  function blend(fg, bg) { const a = fg.a == null ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) }; }
  function effBg(el) {
    const chain = []; let node = el;
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
    const cs = getComputedStyle(el); const bg = effBg(el); const raw = toRgb(cs.color);
    const fg = raw && bg ? blend(raw, bg) : raw;
    return {
      attr: el.hasAttribute("data-om-themify-contrast"),
      color: cs.color,
      ratio: bg && fg ? ratio(fg, bg) : null,
    };
  }
  const out = {};
  for (const id of ["stale","inheritSpan","whiteCard","fine","photo","srOnly","gradientText","ariaHidden","optOut","dimAlpha","bigStale","buttonStale","link"]) {
    out[id] = info(id);
  }
  out.__omBg = getComputedStyle(document.documentElement).getPropertyValue("--om-bg").trim();
  out.__polarity = getComputedStyle(document.documentElement).getPropertyValue("--om-polarity").trim();
  out.__themeName = document.documentElement.getAttribute("data-omarchy-scheme");
  out.__htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  out.__attrCount = document.querySelectorAll("[data-om-themify-contrast]").length;
  out.__hasStyle = !!document.getElementById("omarchy-themify-style");
  return out;
})()
`;

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

async function connect(url) {
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
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  });
}

async function main() {
  if (!fs.existsSync("/usr/bin/chromium")) { console.log("SKIP - chromium not installed"); return; }
  if (!fs.existsSync(HOST_MANIFEST)) { console.log("SKIP - native host manifest not installed (run ./install.sh)"); return; }

  const server = await serve();
  const userDataDir = path.join(os.tmpdir(), "themify-live-" + process.pid);
  // Native-messaging host manifests are looked up under the profile's own data
  // directory, so a throwaway profile needs its own copy.
  const nmDir = path.join(userDataDir, "NativeMessagingHosts");
  fs.mkdirSync(nmDir, { recursive: true });
  fs.copyFileSync(HOST_MANIFEST, path.join(nmDir, "com.omarchy.themify.json"));

  const headed = process.argv.includes("--headed");
  const chrome = spawn("/usr/bin/chromium", [
    ...(headed ? [] : ["--headless=new"]),
    "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--window-size=900,620", "--remote-allow-origins=*",
    "--remote-debugging-port=" + CDP_PORT,
    "--user-data-dir=" + userDataDir,
    "--load-extension=" + ROOT,
    "--disable-extensions-except=" + ROOT,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let wsUrl = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !wsUrl) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl && t.url === "about:blank");
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (_) {}
    if (!wsUrl) await sleep(300);
  }
  if (!wsUrl) { chrome.kill("SIGKILL"); server.close(); console.log("FAIL - no CDP page target"); process.exit(1); }

  const cdp = await connect(wsUrl);
  const evaluate = async (expr, awaitPromise = false) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/fixtures/contrast.html` });
  // Give the service worker time to connect to the native host and fan out.
  await sleep(4000);

  const s = await evaluate(REPORT);
  const themeOk = s.__hasStyle === true && /^#[0-9a-f]{6}$/i.test(s.__omBg || "");
  check("extension loaded and themed the page from the live desktop theme",
    themeOk, JSON.stringify({ hasStyle: s.__hasStyle, omBg: s.__omBg, polarity: s.__polarity }));
  check("page canvas painted by the theme",
    s.__htmlBg !== "rgba(0, 0, 0, 0)", s.__htmlBg);

  if (themeOk) {
    console.log(`     theme: ${s.__omBg} (${s.__polarity})  repairs: ${s.__attrCount}`);
    check("hardcoded #333 ink is readable on the live theme",
      s.stale.ratio >= 4.5, JSON.stringify({ ratio: s.stale.ratio, color: s.stale.color, attr: s.stale.attr }));
    check("inherited dark ink is readable",
      s.inheritSpan.ratio >= 4.5, JSON.stringify({ ratio: s.inheritSpan.ratio }));
    check("light-on-white card is readable",
      s.whiteCard.ratio >= 4.5, JSON.stringify({ ratio: s.whiteCard.ratio }));
    check("hardcoded link colour is readable",
      s.link.ratio >= 4.5, JSON.stringify({ ratio: s.link.ratio }));
    check("saturated button text is readable",
      s.buttonStale.ratio >= 4.5, JSON.stringify({ ratio: s.buttonStale.ratio }));
    check("large dark heading clears 3:1",
      s.bigStale.ratio >= 3.0, JSON.stringify({ ratio: s.bigStale.ratio }));
    check("already-readable text untouched",
      s.fine.attr === false || s.fine.ratio >= 4.5, JSON.stringify({ color: s.fine.color }));
    check("text over a gradient untouched", s.photo.attr === false, JSON.stringify(s.photo));
    check("screen-reader-only text untouched", s.srOnly.attr === false);
    check("gradient text untouched", s.gradientText.attr === false);
    check("aria-hidden text untouched", s.ariaHidden.attr === false);
    check("explicit opt-out untouched", s.optOut.attr === false);
  }

  // The background service worker must be alive — it holds the native messaging
  // port open, which is what keeps the palette flowing to every tab.
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const sw = targets.find((t) => t.type === "service_worker" && String(t.url).includes(EXT_ID));
  check("extension service worker is running (keeps the native port open)", !!sw,
    JSON.stringify(targets.map((t) => t.type + ":" + t.url)));

  cdp.close();
  chrome.kill("SIGKILL");
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("live E2E error:", e && e.message); process.exit(1); });