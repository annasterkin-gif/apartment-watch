"use strict";

/**
 * Apartment Watch — Config UI
 * Run:  node apartment-config-ui.js
 * Open: http://localhost:3456/
 */

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const { spawn } = require("child_process");

const PORT         = 3456;
const CONFIG_PATH  = path.join(__dirname, "apartment-config.json");
const RESULTS_PATH = path.join(__dirname, "last-results.json");
const ZAPIER_URL   = process.env.ZAPIER_WEBHOOK_URL || "";

// ── Translations ────────────────────────────────────────────────────────────────
const TRANSLATIONS = {
  he: {
    dir:           "rtl",
    langToggle:    "EN",
    tabSettings:   "⚙️ הגדרות",
    tabResults:    "🏘 תוצאות",
    subtitle:      "הגדר את פרמטרי החיפוש ולחץ שמור. הסוכן יחפש דירות עם מקלט ביד2 ובפייסבוק.",
    labelCity:     "עיר",
    hintCity:      "(בעברית, לדוגמה: פרדס חנה)",
    placeholderCity: "פרדס חנה",
    labelRoomsMin: "מספר חדרים — מינימום",
    labelRoomsMax: "מספר חדרים — מקסימום",
    labelPrice:    "מחיר מקסימלי (₪ לחודש)",
    hintPrice:     "ריק = ללא הגבלה",
    labelShelter:  "חובה: מקלט בבניין",
    btnSave:       "💾 שמור הגדרות",
    btnRun:        "▶ שמור והפעל עכשיו",
    logTitle:      "📋 לוג הרצה",
    linkResults:   "← צפה בתוצאות",
    flashSaved:    "✓ ההגדרות נשמרו.",
    flashRunning:  "▶ הסוכן פועל — הלוג מוצג למטה.",
    flashAlready:  "⚠ הרצה כבר פעילה, המתן לסיומה.",
    resultsTitle:  "🏘 תוצאות",
    lastRun:       "הרצה אחרונה:",
    newListings:   "דירות חדשות",
    refresh:       "רענן",
    noResults:     "עדיין אין תוצאות.",
    noResultsRun:  'לחץ <a href="/" style="color:#2563eb">הפעל עכשיו</a> בלשונית ההגדרות.',
    noNew:         "לא נמצאו דירות חדשות בהרצה האחרונה.",
    noTitle:       "(ללא כותרת)",
    badgeYad2:     "יד2",
    badgeFbPosts:  "פוסט FB",
    badgeShelter:  "✓ מקלט",
    badgeRooms:    "חדרים",
    linkOpen:      "פתח מודעה ↗",
    groupLabel:    "👥 קבוצה:",
    groupJoin:     "הצטרף ↗",
  },
  en: {
    dir:           "ltr",
    langToggle:    "עב",
    tabSettings:   "⚙️ Settings",
    tabResults:    "🏘 Results",
    subtitle:      "Set your search parameters and click Save. The agent will search for apartments on Yad2 and Facebook.",
    labelCity:     "City",
    hintCity:      "(in Hebrew, e.g. פרדס חנה)",
    placeholderCity: "פרדס חנה",
    labelRoomsMin: "Rooms — minimum",
    labelRoomsMax: "Rooms — maximum",
    labelPrice:    "Max price (₪/month)",
    hintPrice:     "leave blank = no limit",
    labelShelter:  "Required: shelter in building",
    btnSave:       "💾 Save settings",
    btnRun:        "▶ Save & Run now",
    logTitle:      "📋 Run log",
    linkResults:   "→ View results",
    flashSaved:    "✓ Settings saved.",
    flashRunning:  "▶ Agent is running — log shown below.",
    flashAlready:  "⚠ A run is already in progress, please wait.",
    resultsTitle:  "🏘 Results",
    lastRun:       "Last run:",
    newListings:   "new listings",
    refresh:       "Refresh",
    noResults:     "No results yet.",
    noResultsRun:  'Click <a href="/" style="color:#2563eb">Run now</a> in the Settings tab.',
    noNew:         "No new apartments found in the last run.",
    noTitle:       "(no title)",
    badgeYad2:     "Yad2",
    badgeFbPosts:  "FB post",
    badgeShelter:  "✓ Shelter",
    badgeRooms:    "rooms",
    linkOpen:      "Open listing ↗",
    groupLabel:    "👥 Group:",
    groupJoin:     "Join ↗",
  },
};

// ── Language helpers ────────────────────────────────────────────────────────────
function parseLang(req) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)lang=([^;]+)/);
  return (m && m[1] === "en") ? "en" : "he";
}

// ── Config helpers ─────────────────────────────────────────────────────────────
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return { city_hebrew: "", rooms_min: 2, rooms_max: 4, price_max_ils: 8000, require_shelter: true }; }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const p = new URLSearchParams(body);
      resolve(Object.fromEntries(p.entries()));
    });
  });
}

// ── Shared CSS + nav shell ─────────────────────────────────────────────────────
function shell(activeTab, bodyHtml, lang) {
  const t = TRANSLATIONS[lang];
  const tabs = [
    { href: "/",        label: t.tabSettings },
    { href: "/results", label: t.tabResults  },
  ];
  const navItems = tabs.map(tab =>
    `<a href="${tab.href}" class="tab${activeTab === tab.href ? " active" : ""}">${tab.label}</a>`
  ).join("");

  const otherLang  = lang === "he" ? "en" : "he";
  const toggleHref = `/set-lang?lang=${otherLang}&back=${encodeURIComponent(activeTab)}`;

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${t.dir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Apartment Watch</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #f4f6f9;
      color: #222;
      padding: 0 0 40px;
    }
    nav {
      background: #1a3a5c;
      padding: 0 24px;
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .tab {
      display: inline-block;
      padding: 14px 22px;
      color: #a8c4e0;
      text-decoration: none;
      font-size: .95rem;
      font-weight: 600;
      border-bottom: 3px solid transparent;
      transition: color .15s;
    }
    .tab:hover { color: #fff; }
    .tab.active { color: #fff; border-bottom-color: #5ba3f5; }
    .lang-toggle {
      margin-inline-start: auto;
      padding: 6px 14px;
      background: rgba(255,255,255,.12);
      color: #d0e4f7;
      border-radius: 6px;
      text-decoration: none;
      font-size: .82rem;
      font-weight: 700;
      letter-spacing: .05em;
      transition: background .15s;
    }
    .lang-toggle:hover { background: rgba(255,255,255,.22); color: #fff; }
    .page { max-width: 680px; margin: 32px auto; padding: 0 16px; }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 12px rgba(0,0,0,.1);
      padding: 32px;
    }
    h1 { font-size: 1.4rem; margin-bottom: 6px; color: #1a3a5c; }
    .subtitle { color: #666; font-size: .9rem; margin-bottom: 28px; }
    .flash { border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; font-size: .95rem; }
    .flash.ok  { background: #e6f9f0; color: #1a6b3a; border: 1px solid #a3d9b5; }
    .flash.err { background: #fdecea; color: #8b1a1a; border: 1px solid #f5a0a0; }
    .flash.run { background: #e8f0fe; color: #1a3a8b; border: 1px solid #9db8f5; }
    label { display: block; font-weight: 600; font-size: .9rem; margin-bottom: 6px; color: #334; }
    .hint { font-weight: 400; font-size: .78rem; color: #888; margin-inline-start: 6px; }
    input[type="text"], input[type="number"] {
      width: 100%; padding: 10px 12px; border: 1px solid #ccd;
      border-radius: 8px; font-size: 1rem; margin-bottom: 20px; transition: border-color .2s;
    }
    input[type="text"]:focus, input[type="number"]:focus {
      outline: none; border-color: #4a7fc1; box-shadow: 0 0 0 3px rgba(74,127,193,.15);
    }
    .row { display: flex; gap: 16px; }
    .row > div { flex: 1; }
    .checkbox-row { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
    .checkbox-row input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; accent-color: #4a7fc1; }
    .checkbox-row label { margin: 0; cursor: pointer; font-size: 1rem; }
    .buttons { display: flex; gap: 12px; flex-wrap: wrap; }
    button {
      flex: 1; padding: 12px 20px; border: none; border-radius: 8px;
      font-size: 1rem; font-weight: 600; cursor: pointer; transition: filter .15s;
    }
    button:hover { filter: brightness(1.08); }
    .btn-save { background: #4a7fc1; color: #fff; }
    .btn-run  { background: #2e7d46; color: #fff; }
    hr.divider { border: none; border-top: 1px solid #eee; margin: 28px 0; }
    .log-section h2 { font-size: 1rem; color: #444; margin-bottom: 12px; }
    pre#log {
      background: #1e1e2e; color: #cdd6f4; border-radius: 8px; padding: 16px;
      font-size: .8rem; line-height: 1.5; max-height: 340px; overflow-y: auto;
      white-space: pre-wrap; word-break: break-all;
    }
    .spinner { display: inline-block; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* Results page */
    .run-meta { font-size: .85rem; color: #666; margin-bottom: 20px; }
    .apt-grid { display: flex; flex-direction: column; gap: 16px; }
    .apt-card {
      background: #fff; border-radius: 10px; padding: 20px 24px;
      box-shadow: 0 1px 6px rgba(0,0,0,.08); border-inline-start: 4px solid #4a7fc1;
    }
    .apt-card .apt-title {
      font-size: 1.05rem; font-weight: 700; color: #1a3a5c; margin-bottom: 10px;
    }
    .apt-meta { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
    .badge {
      display: inline-block; padding: 3px 10px; border-radius: 20px;
      font-size: .78rem; font-weight: 600;
    }
    .badge-yad2      { background: #dbeafe; color: #1e40af; }
    .badge-fb-market { background: #e0f2fe; color: #0369a1; }
    .badge-fb-posts  { background: #ede9fe; color: #5b21b6; }
    .badge-shelter   { background: #dcfce7; color: #166534; }
    .badge-price     { background: #fef9c3; color: #854d0e; }
    .badge-rooms     { background: #f1f5f9; color: #475569; }
    .apt-desc { font-size: .85rem; color: #555; line-height: 1.5; margin-bottom: 10px; }
    .apt-link a { font-size: .85rem; color: #2563eb; word-break: break-all; }
    .apt-phone { font-size: .85rem; color: #444; margin-top: 4px; }
    .apt-group { font-size: .85rem; color: #6b21a8; margin-top: 4px; }
    .apt-group a { color: #7c3aed; }
    .empty-state { text-align: center; color: #888; padding: 48px 0; font-size: 1rem; }
  </style>
</head>
<body>
  <nav>
    ${navItems}
    <a href="${toggleHref}" class="lang-toggle">${t.langToggle}</a>
  </nav>
  <div class="page">${bodyHtml}</div>
</body>
</html>`;
}

// ── Settings page ──────────────────────────────────────────────────────────────
function renderPage(cfg, flash, lang) {
  const t = TRANSLATIONS[lang];
  const shelterChecked = cfg.require_shelter ? "checked" : "";
  const flashHtml = flash
    ? `<div class="flash ${flash.type}">${flash.msg}</div>`
    : "";

  return shell("/", `
    <div class="card">
      <h1>🏠 Apartment Watch</h1>
      <p class="subtitle">${t.subtitle}</p>

      ${flashHtml}

      <form method="POST" action="/save">
        <label>${t.labelCity} <span class="hint">${t.hintCity}</span></label>
        <input type="text" name="city_hebrew" value="${esc(cfg.city_hebrew)}"
               placeholder="${t.placeholderCity}" dir="rtl" required>

        <div class="row">
          <div>
            <label>${t.labelRoomsMin}</label>
            <input type="number" name="rooms_min" value="${cfg.rooms_min ?? ""}"
                   min="1" max="20" step="0.5" placeholder="2">
          </div>
          <div>
            <label>${t.labelRoomsMax}</label>
            <input type="number" name="rooms_max" value="${cfg.rooms_max ?? ""}"
                   min="1" max="20" step="0.5" placeholder="4">
          </div>
        </div>

        <label>${t.labelPrice} <span class="hint">${t.hintPrice}</span></label>
        <input type="number" name="price_max_ils" value="${cfg.price_max_ils ?? ""}"
               min="0" step="500" placeholder="8000">

        <div class="checkbox-row">
          <input type="checkbox" id="shelter" name="require_shelter" value="true" ${shelterChecked}>
          <label for="shelter">${t.labelShelter}</label>
        </div>

        <div class="buttons">
          <button type="submit" class="btn-save">${t.btnSave}</button>
          <button type="submit" formaction="/run" class="btn-run">${t.btnRun}</button>
        </div>
      </form>

      <hr class="divider">

      <div class="log-section" id="logSection" style="display:none">
        <h2>${t.logTitle} <span class="spinner" id="spinner">⟳</span></h2>
        <pre id="log"></pre>
      </div>
    </div>

    <script>
      const params = new URLSearchParams(location.search);
      if (params.get("running") === "1") {
        document.getElementById("logSection").style.display = "block";
        const logEl   = document.getElementById("log");
        const spinner = document.getElementById("spinner");
        const evtSrc  = new EventSource("/log-stream");
        evtSrc.onmessage = e => {
          logEl.textContent += e.data + "\\n";
          logEl.scrollTop = logEl.scrollHeight;
        };
        evtSrc.addEventListener("done", () => {
          spinner.style.display = "none";
          evtSrc.close();
          const link = document.createElement("a");
          link.href = "/results";
          link.textContent = ${JSON.stringify(TRANSLATIONS[lang].linkResults)};
          link.style.cssText = "display:block;margin-top:12px;color:#2563eb;font-weight:600";
          logEl.parentElement.appendChild(link);
        });
      }
    </script>
  `, lang);
}

// ── Results page ───────────────────────────────────────────────────────────────
function renderResults(lang) {
  const t = TRANSLATIONS[lang];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
  } catch {
    return shell("/results", `
      <div class="card empty-state">
        <p>${t.noResults}</p>
        <p style="margin-top:8px;font-size:.85rem">${t.noResultsRun}</p>
      </div>
    `, lang);
  }

  const items  = data.items || [];
  const ts     = data.run_timestamp_local || "";
  const city   = data.city || "";

  function platformBadge(p) {
    if (p === "yad2")                return `<span class="badge badge-yad2">${t.badgeYad2}</span>`;
    if (p === "facebook_marketplace") return `<span class="badge badge-fb-market">Marketplace</span>`;
    return                                   `<span class="badge badge-fb-posts">${t.badgeFbPosts}</span>`;
  }

  const cards = items.length === 0
    ? `<div class="empty-state">${t.noNew}</div>`
    : items.map(it => `
      <div class="apt-card">
        <div class="apt-title">${esc(it.title || t.noTitle)}</div>
        <div class="apt-meta">
          ${platformBadge(it.platform)}
          ${it.hasShelter ? `<span class="badge badge-shelter">${t.badgeShelter}</span>` : ""}
          ${it.priceText  ? `<span class="badge badge-price">₪ ${esc(it.priceText)}</span>` : ""}
          ${it.rooms      ? `<span class="badge badge-rooms">${esc(it.rooms)} ${t.badgeRooms}</span>` : ""}
        </div>
        ${it.description_snippet
          ? `<div class="apt-desc">${esc(it.description_snippet.slice(0, 220))}</div>`
          : ""}
        ${it.contact ? `<div class="apt-phone">📞 ${esc(it.contact)}</div>` : ""}
        ${it.group_name && it.group_url
          ? `<div class="apt-group">${t.groupLabel} <a href="${esc(it.group_url)}" target="_blank">${esc(it.group_name)} — ${t.groupJoin}</a></div>`
          : it.group_name
          ? `<div class="apt-group">${t.groupLabel} ${esc(it.group_name)}</div>`
          : ""}
        <div class="apt-link"><a href="${esc(it.url)}" target="_blank">${t.linkOpen}</a></div>
      </div>
    `).join("");

  return shell("/results", `
    <h1 style="margin-bottom:6px">${t.resultsTitle} — ${esc(city)}</h1>
    <div class="run-meta">
      ${t.lastRun} ${esc(ts)} &nbsp;·&nbsp;
      ${items.length} ${t.newListings}
      <a href="/results" style="margin-inline-start:12px;font-size:.8rem;color:#2563eb">${t.refresh}</a>
    </div>
    <div class="apt-grid">${cards}</div>
  `, lang);
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

// ── Live log stream (SSE) ──────────────────────────────────────────────────────
let activeLogLines = [];   // buffer for late-joining clients
let sseClients     = [];   // active SSE connections
let runInProgress  = false;

function broadcastLog(line) {
  activeLogLines.push(line);
  for (const res of sseClients) {
    try { res.write(`data: ${line}\n\n`); } catch {}
  }
}

function broadcastDone() {
  for (const res of sseClients) {
    try { res.write(`event: done\ndata: done\n\n`); } catch {}
  }
  sseClients = [];
}

function runApartmentWatch(cfg) {
  if (runInProgress) return;
  runInProgress  = true;
  activeLogLines = [];

  const env = Object.assign({}, process.env, {
    ZAPIER_WEBHOOK_URL: ZAPIER_URL,
  });

  const child = spawn(process.execPath, [path.join(__dirname, "apartment-watch.js")], {
    cwd: __dirname,
    env,
    windowsHide: true,
  });

  child.stdout.on("data", d => String(d).split("\n").forEach(l => { if (l) broadcastLog(l); }));
  child.stderr.on("data", d => String(d).split("\n").forEach(l => { if (l) broadcastLog("ERR: " + l); }));
  child.on("close", code => {
    broadcastLog(`\n=== Process exited (code ${code}) ===`);
    broadcastDone();
    runInProgress = false;
  });
}

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // GET /set-lang — set language cookie and redirect back
  if (req.method === "GET" && u.pathname === "/set-lang") {
    const lang = u.searchParams.get("lang") === "en" ? "en" : "he";
    const back = u.searchParams.get("back") || "/";
    res.writeHead(302, {
      "Set-Cookie": `lang=${lang}; Path=/; Max-Age=31536000`,
      "Location":   back,
    });
    res.end();
    return;
  }

  // GET /results — results page
  if (req.method === "GET" && u.pathname === "/results") {
    const lang = parseLang(req);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderResults(lang));
    return;
  }

  // GET / — show form
  if (req.method === "GET" && u.pathname === "/") {
    const lang = parseLang(req);
    const t    = TRANSLATIONS[lang];
    const flash = u.searchParams.get("saved")   ? { type: "ok",  msg: t.flashSaved   }
               : u.searchParams.get("running")   ? { type: "run", msg: t.flashRunning }
               : u.searchParams.get("already")   ? { type: "err", msg: t.flashAlready }
               : null;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPage(readConfig(), flash, lang));
    return;
  }

  // GET /log-stream — SSE
  if (req.method === "GET" && u.pathname === "/log-stream") {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    });
    for (const line of activeLogLines) res.write(`data: ${line}\n\n`);
    if (!runInProgress) { res.write(`event: done\ndata: done\n\n`); res.end(); return; }
    sseClients.push(res);
    req.on("close", () => { sseClients = sseClients.filter(r => r !== res); });
    return;
  }

  // POST /save — save config only
  if (req.method === "POST" && u.pathname === "/save") {
    const data = await parseBody(req);
    const cfg  = buildConfig(data);
    writeConfig(cfg);
    res.writeHead(302, { Location: "/?saved=1" });
    res.end();
    return;
  }

  // POST /run — save config + run
  if (req.method === "POST" && u.pathname === "/run") {
    if (runInProgress) {
      res.writeHead(302, { Location: "/?already=1" });
      res.end();
      return;
    }
    const data = await parseBody(req);
    const cfg  = buildConfig(data);
    writeConfig(cfg);
    runApartmentWatch(cfg);
    res.writeHead(302, { Location: "/?running=1" });
    res.end();
    return;
  }

  res.writeHead(404); res.end("Not found");
});

function buildConfig(data) {
  return {
    city_hebrew:     (data.city_hebrew || "").trim(),
    rooms_min:       data.rooms_min     ? parseFloat(data.rooms_min)    : null,
    rooms_max:       data.rooms_max     ? parseFloat(data.rooms_max)    : null,
    price_max_ils:   data.price_max_ils ? parseInt(data.price_max_ils)  : null,
    require_shelter: data.require_shelter === "true",
  };
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Apartment Watch config UI running at http://localhost:${PORT}/`);
  console.log("Press Ctrl+C to stop.");
});
