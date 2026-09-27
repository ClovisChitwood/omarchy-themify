// Regenerates the two README screenshots (docs/contrast-before.png and
// docs/contrast-after.png) from docs/demo-page.html.
//
// The page under the lens is docs/demo-page.html: a plain light article with its
// ink written inline, the way real sites ship it.
//
// It drives the real content scripts — not a mock-up — through the same raw-CDP
// harness the E2E test uses:
//   1. the harness stub answers the palette fetch with repair OFF, so the page
//      is themed but the hardcoded dark ink is still invisible  -> "before"
//   2. a repair-on palette message (what the popup toggle sends) repairs the
//      unreadable runs                                          -> "after"
//
// Run: node docs/capture-screenshots.js
// Output: docs/contrast-before.png, docs/contrast-after.png (1180x900)

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 8734;
const CDP_PORT = 9336;
const OUT_W = 1180, SCALE = 2;   // output is 1180 px wide; height follows the content
const MODULES = ["omarchy-colors.js", "omarchy-surfaces.js", "omarchy-sites.js", "omarchy-contrast.js", "content.js"];

// A stock dark Omarchy theme (retro-82), matching what the E2E uses.
const PALETTE = {
  name: "retro-82", found: true, mode: "dark",
  accent: "#faa968", selection: "#134e5a", muted: "#2a6b78",
  background: "#05182e", dark_background: "#031222", darker_background: "#020c17",
  lighter_background: "#0a2540", foreground: "#f6dcac", dark_foreground: "#3f8f8a",
  bright_foreground: "#f6dcac", red: "#f85525", green: "#028391", yellow: "#e97b3c",
  blue: "#3f8f8a", cyan: "#8cbfb8", magenta: "#3f8f8a", orange: "#faa968",
};

// ---------------------------------------------------------------------------
// the page under the lens: docs/demo-page.html, an ordinary light article page
// with every run of ink hardcoded inline. Edit that file, not this one.
// ---------------------------------------------------------------------------

const DEMO = path.join(__dirname, "demo-page.html");

const HARNESS = `
window.__themifyPalette = ${JSON.stringify(PALETTE)};
window.__themifyHandlers = [];
window.chrome = {
  runtime: {
    // repair OFF at load: the page is themed, the stale ink is left alone
    sendMessage(msg, cb) { if (cb) cb({ palette: window.__themifyPalette, enabled: true, repair: false }); },
    onMessage: { addListener(h) { window.__themifyHandlers.push(h); } },
    lastError: undefined,
  },
};
window.__sendPalette = (opts) => {
  const msg = Object.assign({ type: "omarchy-themify:palette", palette: window.__themifyPalette, enabled: true, repair: true }, opts || {});
  window.__themifyHandlers.forEach((h) => h(msg, null, () => {}));
};
`;

// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(DEMO, "utf8"));
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

async function waitForCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const page = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
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
  if (!fs.existsSync("/usr/bin/chromium")) {
    console.error("/usr/bin/chromium not present");
    process.exit(1);
  }
  const server = await serve();
  const chrome = spawn("/usr/bin/chromium", [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    `--window-size=${OUT_W / SCALE},720`,
    `--force-device-scale-factor=${SCALE}`,
    "--remote-allow-origins=*",
    "--remote-debugging-port=" + CDP_PORT,
    "--user-data-dir=" + path.join(os.tmpdir(), "themify-shots-" + process.pid),
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const wsUrl = await waitForCdp(15000);
  if (!wsUrl) { chrome.kill("SIGKILL"); console.error("headless chromium did not expose CDP"); process.exit(1); }

  const cdp = await connect(wsUrl);
  const evaluate = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const shoot = async (file) => {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(r.data, "base64");
    fs.writeFileSync(path.join(ROOT, "docs", file), buf);
    console.log(`wrote docs/${file} (${buf.length} bytes)`);
  };

  const scripts = MODULES.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n");
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HARNESS + "\n" + scripts });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1400);

  const themed = await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--om-bg').trim()");
  if (!themed) { console.error("FAIL: the content scripts did not theme the page"); chrome.kill("SIGKILL"); server.close(); process.exit(1); }
  console.log(`theme applied: --om-bg = ${themed}`);

  // Size the viewport to the whole message, so the shot is the entire email
  // body rather than the first screenful of it.
  // Measure the message itself, not the window: a fixed window leaves dead
  // space at the bottom of the PNG.
  const viewportH = await evaluate(`(() => {
    return Math.ceil(Math.max(document.body.scrollHeight, 200));
  })()`);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: OUT_W / SCALE, height: viewportH, deviceScaleFactor: SCALE, mobile: false,
  });
  await sleep(400);
  console.log(`viewport: ${OUT_W / SCALE}x${viewportH} @${SCALE}x`);

  // Measure the second body paragraph (hardcoded #333 ink) and how many runs
  // the repair pass has touched. The "before" image only means anything if the
  // ink is still the page's own colour at that moment.
  const probe = `(() => {
    const paras = [...document.querySelectorAll('article p, p')].filter((p) => p.style.color === 'rgb(51, 51, 51)' || p.style.color === '#333333');
    const p = paras[0];
    return {
      ink: p ? getComputedStyle(p).color : null,
      bg: getComputedStyle(document.documentElement).backgroundColor,
      fixed: document.querySelectorAll('[data-om-themify-contrast="fixed"]').length,
    };
  })()`;

  // 1) BEFORE — themed, repair off, the hardcoded #333 ink is still invisible.
  const before = await evaluate(probe);
  console.log(`before: ink ${before.ink} on ${before.bg}, repaired runs ${before.fixed}`);
  if (before.fixed !== 0) { console.error("FAIL: repair already applied before the 'before' shot"); chrome.kill("SIGKILL"); server.close(); process.exit(1); }
  if (before.ink !== "rgb(51, 51, 51)") { console.error(`FAIL: expected the page's own #333 ink, got ${before.ink} — the 'before' shot would not show the bug`); chrome.kill("SIGKILL"); server.close(); process.exit(1); }
  await shoot("contrast-before.png");

  // 2) AFTER — the popup's repair toggle, i.e. a repair-on palette message.
  await evaluate("window.__sendPalette({ repair: true })");
  await sleep(1800);
  const after = await evaluate(probe);
  console.log(`after: ink ${after.ink}, repaired runs ${after.fixed}`);
  if (!after.fixed) { console.error("FAIL: the repair pass changed nothing"); chrome.kill("SIGKILL"); server.close(); process.exit(1); }
  if (after.ink === "rgb(51, 51, 51)") { console.error("FAIL: the paragraphs kept their unreadable ink"); chrome.kill("SIGKILL"); server.close(); process.exit(1); }
  await shoot("contrast-after.png");

  cdp.close();
  chrome.kill("SIGKILL");
  server.close();
  console.log("done");
}

main();