// Manifest wiring tests. These catch silent regressions: a content script
// dropped from the list, all_frames flipped off, or the MAIN-world script
// accidentally moved to the isolated world (which breaks the whole
// prefers-color-scheme feature without any runtime error).
//
// Run: node test-manifest.js

const fs = require("fs");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS - " + name); }
  else { fail++; console.log("FAIL - " + name + (detail ? "  (" + detail + ")" : "")); }
}

const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));

check("MV3", m.manifest_version === 3);
check("pins extension ID via key", typeof m.key === "string" && m.key.length > 40);
check("no host_permissions (privacy-minimal)", Array.isArray(m.host_permissions) && m.host_permissions.length === 0);
check("permissions limited to nativeMessaging + storage",
  JSON.stringify(m.permissions.slice().sort()) === JSON.stringify(["nativeMessaging", "storage"]),
  JSON.stringify(m.permissions));

const scripts = m.content_scripts || [];
check("exactly two content script groups", scripts.length === 2, "got " + scripts.length);

const main = scripts.find((s) => s.world === "MAIN");
const iso = scripts.find((s) => s.world !== "MAIN");

check("a MAIN-world group exists", !!main);
check("MAIN-world script is the matchMedia shim",
  !!main && main.js.includes("inject-prefers-color-scheme.js"), main && JSON.stringify(main.js));
check("MAIN-world runs at document_start (before app JS)", !!main && main.run_at === "document_start");

check("isolated group exists", !!iso);
for (const f of ["omarchy-colors.js", "omarchy-surfaces.js", "omarchy-sites.js", "omarchy-contrast.js", "content.js"]) {
  check("isolated group loads " + f, !!iso && iso.js.includes(f), iso && JSON.stringify(iso.js));
}
check("isolated group runs at document_start", !!iso && iso.run_at === "document_start");

// Load order matters: the site packs read globalThis.OmarchyColors, and
// content.js reads globalThis.OmarchySites.
const order = iso ? iso.js : [];
check("omarchy-colors.js loads before omarchy-surfaces.js",
  order.indexOf("omarchy-colors.js") < order.indexOf("omarchy-surfaces.js"));
check("omarchy-colors.js loads before omarchy-sites.js",
  order.indexOf("omarchy-colors.js") < order.indexOf("omarchy-sites.js"));
check("omarchy-sites.js loads before content.js",
  order.indexOf("omarchy-sites.js") < order.indexOf("content.js"));
// The repair pass needs the color helpers, and content.js drives it.
check("omarchy-colors.js loads before omarchy-contrast.js",
  order.indexOf("omarchy-colors.js") < order.indexOf("omarchy-contrast.js"));
check("omarchy-contrast.js loads before content.js",
  order.indexOf("omarchy-contrast.js") < order.indexOf("content.js"));

// all_frames: the whole point of this revision.
check("MAIN-world runs in all frames", !!main && main.all_frames === true, main && String(main.all_frames));
check("isolated runs in all frames", !!iso && iso.all_frames === true, iso && String(iso.all_frames));
check("MAIN-world matches about:blank frames too", !!main && main.match_about_blank === true);
check("isolated matches about:blank frames too", !!iso && iso.match_about_blank === true);
check("both groups match all urls",
  !!main && !!iso &&
  JSON.stringify(main.matches) === JSON.stringify(["<all_urls>"]) &&
  JSON.stringify(iso.matches) === JSON.stringify(["<all_urls>"]));

// Service worker + popup still wired
check("background service worker declared", m.background && m.background.service_worker === "background.js");
check("popup declared", m.action && m.action.default_popup === "popup.html");

// Every element the popup script grabs must exist in the popup markup, or the
// popup dies silently on a missing id.
{
  const html = fs.readFileSync(m.action.default_popup, "utf8");
  const js = fs.readFileSync("popup.js", "utf8");
  const ids = [...js.matchAll(/\$\("([^"]+)"\)/g)].map((mt) => mt[1]);
  check("popup.js looks up at least one element", ids.length > 0);
  for (const id of [...new Set(ids)]) {
    check("popup.html contains #" + id, html.includes(`id="${id}"`));
  }
  check("popup has a repair toggle", html.includes('id="repair"'));
}

// Files referenced must actually exist on disk
const referenced = [
  m.background.service_worker,
  m.action.default_popup,
  ...(m.content_scripts || []).flatMap((s) => s.js),
  ...Object.values(m.icons || {}),
  ...Object.values((m.action && m.action.default_icon) || {}),
];
for (const f of [...new Set(referenced)]) {
  check("referenced file exists: " + f, fs.existsSync(f));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
