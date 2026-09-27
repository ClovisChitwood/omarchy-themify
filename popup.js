// Omarchy Themify popup — reads state from the background worker.

const $ = (id) => document.getElementById(id);
const keys = [
  "background", "foreground", "accent", "muted", "selection",
  "red", "green", "blue", "yellow", "orange", "cyan", "magenta",
];
const keyLabels = {
  background: "bg", foreground: "fg", accent: "accent", muted: "muted",
  selection: "sel", red: "red", green: "grn", blue: "blu", yellow: "yel",
  orange: "org", cyan: "cyn", magenta: "mag",
};

function renderState({ enabled, repair, palette }) {
  $("enable").checked = enabled !== false;
  $("repair").checked = repair !== false;

  const sw = $("swatches");
  sw.innerHTML = "";
  if (palette && palette.found) {
    for (const k of keys) {
      const val = palette[k];
      if (!val) continue;
      const d = document.createElement("div");
      d.className = "swatch";
      d.title = `${keyLabels[k] || k}: ${val}`;
      d.style.background = val;
      sw.appendChild(d);
    }
    $("themeName").textContent = palette.name || "current theme";
    $("meta").textContent = `mode: ${palette.mode || "?"}`;
  } else {
    $("themeName").textContent = "no palette yet";
    $("meta").textContent = "";
  }
}

$("enable").addEventListener("change", (e) => {
  chrome.runtime.sendMessage(
    { type: "omarchy-themify:set-enabled", enabled: e.target.checked },
    () => setStatus(e.target.checked ? "enabled" : "disabled")
  );
});

$("repair").addEventListener("change", (e) => {
  chrome.runtime.sendMessage(
    { type: "omarchy-themify:set-repair", repair: e.target.checked },
    () => { setStatus(e.target.checked ? "repair on" : "repair off"); loadStats(); }
  );
});

$("refresh").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "omarchy-themify:refresh" }, () => {
    setStatus("re-reading theme…");
    load();
    loadStats();
  });
});

/** How many text runs the repair pass had to adjust on the tab we're on. */
function loadStats() {
  const out = $("repairs");
  out.textContent = "";
  if (!chrome.tabs || !chrome.tabs.query) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs && tabs[0] && tabs[0].id;
    if (id == null) return;
    chrome.tabs.sendMessage(id, { type: "omarchy-themify:contrast-stats" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.stats) return; // page has no content script
      const { fixed, checked } = resp.stats;
      out.textContent = fixed
        ? `${fixed} text run${fixed === 1 ? "" : "s"} repaired here`
        : `nothing to repair here (${checked} checked)`;
    });
  });
}

function setStatus(t) {
  $("status").textContent = t;
  setTimeout(() => { $("status").textContent = ""; }, 1800);
}

function showError(msg) {
  $("error").textContent = msg;
  $("error").hidden = !msg;
}

function load() {
  chrome.runtime.sendMessage({ type: "omarchy-themify:get-state" }, (resp) => {
    const err = chrome.runtime.lastError;
    if (err) return showError("background worker unavailable: " + err.message);
    if (resp) renderState(resp);
    else showError("no response from background worker");
  });
}

load();
loadStats();
