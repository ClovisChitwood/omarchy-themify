// Omarchy Themify — background service worker.
//
// Holds a persistent connection to the native host, caches the last palette,
// and pushes palette changes to every content script. The host itself watches
// the theme file, so a theme switch arrives here unprompted.

const HOST_NAME = "com.omarchy.themify";
const PALETTE_MSG = "omarchy-themify:palette";
const ENABLED_KEY = "omarchyThemifyEnabled";
// Repair text the theme made unreadable (dark ink on a now-dark canvas).
const REPAIR_KEY = "omarchyThemifyRepairContrast";

let port = null;
let connected = false;
let lastPalette = null;
let reconnectTimer = null;

// ---- state ----------------------------------------------------------------

async function getEnabled() {
  try {
    const { [ENABLED_KEY]: v } = await chrome.storage.sync.get(ENABLED_KEY);
    return v !== false; // default ON
  } catch {
    return true;
  }
}

async function setEnabled(on) {
  await chrome.storage.sync.set({ [ENABLED_KEY]: !!on });
}

async function getRepair() {
  try {
    const { [REPAIR_KEY]: v } = await chrome.storage.sync.get(REPAIR_KEY);
    return v !== false; // default ON
  } catch {
    return true;
  }
}

async function setRepair(on) {
  await chrome.storage.sync.set({ [REPAIR_KEY]: !!on });
}

// ---- native messaging ------------------------------------------------------

function connect() {
  if (connected) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  connected = true;

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "palette" || !msg.palette) return;
    lastPalette = msg.palette;
    fanOut(msg.palette);
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError; // consume it
    connected = false;
    port = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  // Keep the native host warm; retry in case the browser restarted it.
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!connected) connect();
  }, 3000);
}

// ---- fan-out ---------------------------------------------------------------

async function fanOut(palette) {
  const [enabled, repair] = await Promise.all([getEnabled(), getRepair()]);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || tab.id < 0) continue;
    chrome.tabs.sendMessage(tab.id, { type: PALETTE_MSG, palette, enabled, repair })
      .catch(() => {}); // tab not ready / no content script; fine
  }
}

// ---- messages from popup / content ----------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  switch (msg.type) {
    case "omarchy-themify:get-palette": {
      // Content script requests the current palette + settings on load.
      (async () => {
        const [enabled, repair] = await Promise.all([getEnabled(), getRepair()]);
        sendResponse({ palette: lastPalette, enabled, repair });
      })();
      // Ensure a host connection exists so we can refresh promptly.
      if (!connected) connect();
      return true; // async
    }

    case "omarchy-themify:get-state": {
      (async () => {
        const [enabled, repair] = await Promise.all([getEnabled(), getRepair()]);
        // Force a fresh palette read if we don't have one yet.
        if (!lastPalette) connect();
        sendResponse({ enabled, repair, palette: lastPalette });
      })();
      return true; // async
    }

    case "omarchy-themify:set-enabled": {
      (async () => {
        await setEnabled(!!msg.enabled);
        const palette = lastPalette;
        // Re-fan so open tabs apply/clear per the new setting.
        if (palette) await fanOut(palette);
        sendResponse({ ok: true });
      })();
      return true;
    }

    case "omarchy-themify:set-repair": {
      (async () => {
        await setRepair(!!msg.repair);
        const palette = lastPalette;
        if (palette) await fanOut(palette);
        sendResponse({ ok: true });
      })();
      return true;
    }

    case "omarchy-themify:refresh": {
      // Drop cache and force host to re-send current palette.
      lastPalette = null;
      if (connected && port) port.postMessage({ cmd: "ping" });
      else connect();
      sendResponse({ ok: true });
      return false;
    }
  }
  return false;
});

// ---- lifecycle -------------------------------------------------------------

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
connect();
