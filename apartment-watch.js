"use strict";

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

// ── Configuration ──────────────────────────────────────────────────────────────
const CONFIG_PATH      = path.join(__dirname, "apartment-config.json");
const SEEN_PATH        = path.join(__dirname, "apartment-seen.json");
const HEARTBEAT_PATH   = path.join(__dirname, "apartment-heartbeat.txt");
const FB_STORAGE_STATE = path.join(__dirname, "facebook-state.json");
const YAD2_STATE_PATH  = path.join(__dirname, "yad2-state.json");
const RESULTS_PATH     = path.join(__dirname, "last-results.json");

const GMAIL_SCRIPT_URL   = process.env.GMAIL_SCRIPT_URL   || "";
const NOTIFY_EMAIL       = process.env.NOTIFY_EMAIL       || "";
const SCRAPER_API_KEY    = process.env.SCRAPER_API_KEY    || "";
const MAX_YAD2_TO_FETCH = 30;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.log("ERROR: Cannot read apartment-config.json:", String(e));
    process.exit(1);
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function nowLocalISO() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function getTodayDate() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

function loadSeenKeys() {
  try {
    const arr = JSON.parse(fs.readFileSync(SEEN_PATH, "utf8"));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveSeenKeys(set) {
  try { fs.writeFileSync(SEEN_PATH, JSON.stringify(Array.from(set), null, 2), "utf8"); }
  catch (e) { console.log("WARN_SEEN_SAVE_FAILED:", String(e).slice(0, 120)); }
}

function isHeartbeatDue() {
  try { return fs.readFileSync(HEARTBEAT_PATH, "utf8").trim() !== getTodayDate(); }
  catch { return true; }
}

function markHeartbeatSent() {
  try { fs.writeFileSync(HEARTBEAT_PATH, getTodayDate(), "utf8"); }
  catch (e) { console.log("WARN_HEARTBEAT_SAVE_FAILED:", String(e).slice(0, 80)); }
}

function makeDedupeKey(platform, url) { return `${platform}|${url}`; }

// ── Domain helpers ─────────────────────────────────────────────────────────────
function looksLikeShelter(text) {
  return /(מקלט|ממ"ד|ממד|safe\s*room|saferoom|shelter)/i.test(text || "");
}

function parseRoomsFromText(text) {
  if (!text) return null;
  const m = text.match(/(\d+(?:[.,]\d)?)\s*(?:חדרים|חדרי|חדר)/);
  if (m) return parseFloat(m[1].replace(",", "."));
  return null;
}

function roomsInRange(text, min, max) {
  const rooms = parseRoomsFromText(text);
  if (rooms === null) return true; // can't determine — let it through
  if (min && rooms < min) return false;
  if (max && rooms > max) return false;
  return true;
}

function priceUnderMax(text, maxPrice) {
  if (!maxPrice || !text) return true;
  const m = text.match(/₪\s*([\d,]+)/);
  if (!m) return true; // can't determine — let it through
  const price = parseInt(m[1].replace(/,/g, ""), 10);
  return price <= maxPrice;
}

function looksBotOrOops(text, title) {
  return /ShieldSquare|captcha|access denied|verify you are human|robot check|unusual traffic/i
    .test(`${text || ""} ${title || ""}`);
}

function isGoodApartmentUrl(url) {
  if (!url) return false;
  return /yad2\.co\.il\/(item|realestate\/item)\/[0-9a-zA-Z-]{6,}/i.test(url);
}

// ── JSON walking ───────────────────────────────────────────────────────────────
// Collect listing IDs from intercepted Yad2 JSON responses.
// shelterOnly: only IDs whose nearby text mentions מקלט.
// cityFilter:  only IDs whose nearby text contains the first word of the city.
function extractListingIdsFromJson(obj, shelterOnly, cityFilter) {
  const cityWord = cityFilter
    ? (cityFilter.split(/[\s\-]+/).find(w => w.length >= 2) || cityFilter)
    : null;

  const ids = new Set();
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { for (const v of x) walk(v); return; }

    const textBlob = Object.values(x).filter(v => typeof v === "string").join(" ");
    let id = null;
    let hasShelterField = false;
    for (const [k, v] of Object.entries(x)) {
      const kl = k.toLowerCase();
      if ((k === "id" || kl === "orderid" || kl === "adnumber" || kl === "token" || kl === "itemid") &&
          (typeof v === "number" || typeof v === "string")) {
        const s = String(v);
        if (/^\d{8,14}$/.test(s)) id = s;
      }
      if (/(shelter|mamad|מקלט|safe.?room)/i.test(kl) && v) hasShelterField = true;
    }

    const cityOk  = !cityWord || textBlob.includes(cityWord);
    const shelter = !shelterOnly || looksLikeShelter(textBlob) || hasShelterField;
    if (id && cityOk && shelter) ids.add(id);

    for (const v of Object.values(x)) {
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(obj);
  return Array.from(ids);
}

// ── DOM URL extraction ─────────────────────────────────────────────────────────
async function extractApartmentUrlsFromDom(page) {
  return page.evaluate(() => {
    const uniq = new Set();
    const urls = [];
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href") || "";
      if (!href) continue;
      let url;
      try { url = href.startsWith("http") ? href : new URL(href, location.origin).toString(); }
      catch { continue; }
      if (!/yad2\.co\.il\/(item|realestate\/item)\/[0-9a-zA-Z-]{6,}/i.test(url)) continue;
      if (url.includes("component-type=recommendation")) continue;
      if (uniq.has(url)) continue;
      uniq.add(url);
      urls.push(url);
      if (urls.length >= 80) break;
    }
    return urls;
  }).catch(() => []);
}

// ── Yad2 filter helpers ────────────────────────────────────────────────────────

// Node.js HTTP fetch to Yad2 autocomplete API — no CORS restrictions
async function lookupCityCodeNodeFetch(cityHebrew) {
  const q  = encodeURIComponent(cityHebrew);
  const q1 = encodeURIComponent(cityHebrew.split(/[\s\-]+/)[0]);
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const commonHeaders = {
    Accept: "application/json",
    Origin: "https://www.yad2.co.il",
    Referer: "https://www.yad2.co.il/realestate/rent",
    "User-Agent": UA,
  };
  const endpoints = [
    `https://gw.yad2.co.il/address-autocomplete/realestate/v2?text=${q}`,  // confirmed working
    `https://gw.yad2.co.il/address-autocomplete/realestate/v2?text=${q1}`,
    `https://gw.yad2.co.il/search-page/realestate/autocomplete?q=${q}`,
    `https://gw.yad2.co.il/geo/city?q=${q}`,
    `https://gw.yad2.co.il/geo/autocomplete?q=${q}&docTypes=city`,
  ];
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, { headers: commonHeaders });
      console.log(`DEBUG_CITY_NODE_FETCH: HTTP ${resp.status} ${url}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const code = extractCityCodeFromJson(data, cityHebrew);
      if (code) { console.log("DEBUG_CITY_NODE_CODE:", code); return code; }
      console.log("DEBUG_CITY_NODE_RESP_SAMPLE:", JSON.stringify(data).slice(0, 300));
    } catch (e) {
      console.log(`DEBUG_CITY_NODE_ERR: ${url} — ${String(e).slice(0, 80)}`);
    }
  }
  return null;
}

// Extract city code from Yad2 autocomplete API responses
function extractCityCodeFromJson(data, cityHebrew) {
  const firstWord = cityHebrew.split(/[\s\-]+/)[0];
  let found = null;
  const walk = (x) => {
    if (!x || typeof x !== "object" || found) return;
    if (Array.isArray(x)) { for (const v of x) walk(v); return; }
    const textVals = Object.values(x).filter(v => typeof v === "string");
    if (textVals.some(v => v.includes(firstWord))) {
      for (const [k, v] of Object.entries(x)) {
        if (/^(id|cityId|city_id|docId|code)$/i.test(k) &&
            (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)))) {
          found = String(v);
        }
      }
    }
    for (const v of Object.values(x)) { if (v && typeof v === "object") walk(v); }
  };
  walk(data);
  return found;
}

async function applyCityFilter(page, cityHebrew) {
  let cityCode = null;

  // Method 0: Node.js HTTP fetch — no CORS, works before browser interaction
  cityCode = await lookupCityCodeNodeFetch(cityHebrew).catch(() => null);
  if (cityCode) console.log("DEBUG_CITY_CODE_FROM_NODE:", cityCode);

  // Method 1: fetch Yad2 autocomplete API directly from browser context (shares cookies/session)
  try {
    const fetchResult = await page.evaluate(async (city) => {
      const logs = [];
      const firstWord = city.split(/[\s\-]+/)[0];
      const findCode = (obj) => {
        if (!obj || typeof obj !== "object") return null;
        if (Array.isArray(obj)) {
          for (const v of obj) { const r = findCode(v); if (r) return r; }
          return null;
        }
        const texts = Object.values(obj).filter(v => typeof v === "string");
        if (texts.some(v => v.includes(firstWord))) {
          for (const [k, v] of Object.entries(obj)) {
            if (/^(id|cityId|city_id|docId|code|value)$/i.test(k)) {
              const n = typeof v === "number" ? v : parseInt(v, 10);
              if (n > 0) return String(n);
            }
          }
        }
        for (const v of Object.values(obj)) {
          if (v && typeof v === "object") { const r = findCode(v); if (r) return r; }
        }
        return null;
      };
      const endpoints = [
        `https://gw.yad2.co.il/address-autocomplete/realestate/v2?text=${encodeURIComponent(city)}`,  // confirmed working
        `https://gw.yad2.co.il/address-autocomplete/realestate/v2?text=${encodeURIComponent(firstWord)}`,
        `https://gw.yad2.co.il/search-page/realestate/autocomplete?q=${encodeURIComponent(city)}`,
        `https://gw.yad2.co.il/geo/city?q=${encodeURIComponent(city)}`,
        `https://gw.yad2.co.il/geo/autocomplete?q=${encodeURIComponent(city)}&docTypes=city`,
      ];
      for (const url of endpoints) {
        try {
          const r = await fetch(url, {
            credentials: "include",
            headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
          });
          logs.push(`DEBUG_CITY_FETCH: HTTP ${r.status} ${url}`);
          if (!r.ok) continue;
          const code = findCode(await r.json());
          if (code) return { code, logs };
        } catch (e) { logs.push(`DEBUG_CITY_FETCH_ERR: ${url} — ${String(e).slice(0, 80)}`); }
      }
      return { code: null, logs };
    }, cityHebrew).catch(() => null);

    if (fetchResult) {
      for (const l of fetchResult.logs) console.log(l);
      cityCode = fetchResult.code || null;
    }
  } catch {}

  if (cityCode) console.log("DEBUG_CITY_CODE_FROM_API:", cityCode);

  // Method 1b: Extract city code from page's __NEXT_DATA__ / inline scripts
  if (!cityCode) {
    cityCode = await page.evaluate((fw) => {
      // Search __NEXT_DATA__ script tag
      const nd = document.getElementById("__NEXT_DATA__");
      if (nd) {
        const str = nd.textContent || "";
        const i = str.indexOf(fw);
        if (i >= 0) {
          const chunk = str.substring(Math.max(0, i - 500), i + 500);
          const m = chunk.match(/"(?:id|cityId|city_id)"\s*:\s*(\d{4,6})/);
          if (m) return m[1];
        }
      }
      // Search inline script tags
      for (const s of Array.from(document.querySelectorAll("script:not([src])"))) {
        const t = s.textContent || "";
        const i = t.indexOf(fw);
        if (i < 0) continue;
        const chunk = t.substring(Math.max(0, i - 300), i + 300);
        const m = chunk.match(/"(?:id|cityId|city_id|code)"\s*:\s*(\d{4,6})/i);
        if (m) return m[1];
      }
      return null;
    }, cityHebrew.split(/[\s\-]+/)[0]).catch(() => null);
    if (cityCode) console.log("DEBUG_CITY_CODE_PAGE_DATA:", cityCode);
  }

  // Method 1c: Look for city-code URLs already in the page (popular cities / navigation links)
  if (!cityCode) {
    cityCode = await page.evaluate((fw) => {
      for (const a of Array.from(document.querySelectorAll('a[href*="city="]'))) {
        const text = (a.textContent || "") + (a.getAttribute("aria-label") || "");
        const href = a.getAttribute("href") || "";
        if (text.includes(fw) || href.includes(fw)) {
          const m = href.match(/[?&]city=(\d+)/);
          if (m) return m[1];
        }
      }
      return null;
    }, cityHebrew.split(/[\s\-]+/)[0]).catch(() => null);
    if (cityCode) console.log("DEBUG_CITY_CODE_PAGE_LINK:", cityCode);
  }

  // Method 2: response interception (ALL JSON from ANY domain) + UI typing
  if (!cityCode) {
    const handler = async (resp) => {
      try {
        const ct = resp.headers()["content-type"] || "";
        if (!ct.includes("json")) return;
        const u = resp.url();
        console.log("DEBUG_ALL_JSON_URL:", u.slice(0, 200));  // log every JSON call
        if (!u.includes("yad2")) return;                       // only extract from yad2
        const data = await resp.json().catch(() => null);
        if (data && !cityCode) cityCode = extractCityCodeFromJson(data, cityHebrew);
      } catch {}
    };
    page.on("response", handler);

    const selectors = [
      'input[placeholder*="עיר"]', 'input[placeholder*="יישוב"]',
      'input[placeholder*="מיקום"]', 'input[placeholder*="חפש"]',
      '[data-test*="city"] input', '[class*="city"] input',
      '[class*="location"] input', 'input[type="search"]', 'input[type="text"]',
    ];
    for (const sel of selectors) {
      if (cityCode) break;
      const loc = page.locator(sel).first();
      if (await loc.count().catch(() => 0) === 0) continue;
      try {
        const info = await loc.evaluate(el =>
          `placeholder="${el.placeholder}" id="${el.id}" class="${el.className.slice(0, 60)}"`
        ).catch(() => "");
        console.log("DEBUG_CITY_INPUT_SEL:", sel, "|", info);

        // Track fetch/XHR requests while typing
        const typingReqs = [];
        const reqH = (req) => {
          if (["fetch", "xhr"].includes(req.resourceType()))
            typingReqs.push(req.url().slice(0, 200));
        };
        page.on("request", reqH);

        // Use JavaScript el.click() — bypasses pointer-events:none and Playwright's
        // actionability checks. The trigger input fires a React handler that opens
        // the search overlay, regardless of CSS state.
        await loc.evaluate(el => el.click()).catch(async () => {
          await loc.click({ timeout: 3000, force: true }).catch(() => {});
        });
        const urlAfterClick = page.url();
        console.log("DEBUG_URL_AFTER_TRIGGER_CLICK:", urlAfterClick.slice(0, 200));
        // Wait for overlay/modal to open and focus to settle
        await page.waitForTimeout(1500);
        const focusedInfo = await page.evaluate(() => {
          const el = document.activeElement;
          return el ? `${el.tagName} placeholder="${el.placeholder}" class="${el.className.slice(0, 80)}"` : "none";
        }).catch(() => "unknown");
        console.log("DEBUG_FOCUSED_AFTER_CLICK:", focusedInfo);

        // If a cookie/consent modal captured focus, dismiss it then reload the page.
        // After accepting, the consent preference is stored (cookie/localStorage), so a
        // fresh page load won't show the modal again and the trigger click will work cleanly.
        if (/cookie|modal_window|consent|gdpr/i.test(focusedInfo)) {
          console.log("DEBUG_COOKIE_MODAL_DETECTED: dismissing cookie and reloading");
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(500);
          const dismissBtn = page.locator(
            '[class*="cookie-i"] button, [class*="cookie"] button:first-child, button:has-text("אישור"), button:has-text("קבל הכל"), button:has-text("Accept")'
          ).first();
          if (await dismissBtn.count().catch(() => 0) > 0) {
            await dismissBtn.evaluate(el => el.click()).catch(() => {});
            console.log("DEBUG_COOKIE_DISMISS_BTN_CLICKED");
            await page.waitForTimeout(800);
          }
          // Reload — consent is now saved; next trigger click opens the search overlay directly
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(3000);
          // Use Playwright's real mouse click (isTrusted:true) so React opens the overlay.
          // el.click() fires an untrusted synthetic event that Yad2 ignores for overlay open.
          await loc.click({ force: true, timeout: 5000 }).catch(() => {
            loc.evaluate(el => el.click()).catch(() => {});
          });
          await page.waitForTimeout(2500);

          // Explicitly find and click the real search input inside the now-open overlay.
          // Loop through inputs, skip the trigger itself (class contains "trigger"), click first visible one.
          const allInputs = page.locator("input");
          const inputCount = await allInputs.count().catch(() => 0);
          let overlayInputFound = false;
          for (let i = 0; i < Math.min(inputCount, 8); i++) {
            const inp = allInputs.nth(i);
            const cls = await inp.getAttribute("class").catch(() => "") || "";
            if (cls.includes("trigger")) continue;
            if (!await inp.isVisible().catch(() => false)) continue;
            await inp.evaluate(el => { el.click(); el.focus(); }).catch(() => {});
            await page.waitForTimeout(400);
            console.log("DEBUG_OVERLAY_INPUT_CLICKED: index", i, "class:", cls.slice(0, 60));
            overlayInputFound = true;
            break;
          }
          if (!overlayInputFound) console.log("DEBUG_OVERLAY_INPUT_NOT_FOUND");

          const focusedInfo2 = await page.evaluate(() => {
            const el = document.activeElement;
            return el ? `${el.tagName} placeholder="${el.placeholder}" class="${el.className.slice(0, 80)}"` : "none";
          }).catch(() => "unknown");
          console.log("DEBUG_FOCUSED_AFTER_COOKIE_DISMISS:", focusedInfo2);
        }

        // Type into whatever is now focused (the real search input in the overlay)
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(cityHebrew, { delay: 80 });
        await page.waitForTimeout(2500);

        page.off("request", reqH);
        if (typingReqs.length) console.log("DEBUG_CITY_TYPE_REQS:", typingReqs.join(" | "));
        else console.log("DEBUG_CITY_TYPE_REQS: none — autocomplete is client-side");

        // Dump HTML near the focused input to see what suggestions appeared
        const autoHtml = await page.evaluate((fw) => {
          // Start from the currently focused element and walk up
          let el = document.activeElement;
          for (let i = 0; i < 10 && el && el !== document.body; i++) {
            const text = el.innerText || "";
            if (text.includes(fw) && text.length < 2000) return el.innerHTML.slice(0, 600);
            el = el.parentElement;
          }
          // Fallback: any visible input that might be the search input
          for (const inp of Array.from(document.querySelectorAll("input"))) {
            if (!inp.offsetParent) continue; // skip hidden
            let p = inp.parentElement;
            for (let i = 0; i < 6 && p; i++) {
              if ((p.innerText || "").includes(fw)) return p.innerHTML.slice(0, 600);
              p = p.parentElement;
            }
          }
          return null;
        }, cityHebrew.split(/[\s\-]+/)[0]).catch(() => null);
        if (autoHtml) console.log("DEBUG_AUTOCOMPLETE_HTML:", autoHtml.replace(/\s+/g, " ").slice(0, 400));

        // Try click-based selection
        if (!cityCode) {
          const opt = page.locator('[role="option"], [class*="suggestion"], [class*="autocomplete"] li, li[data-value]').first();
          if (await opt.count().catch(() => 0) > 0) {
            await opt.click({ timeout: 3000 });
            await page.waitForTimeout(1500);
          }
        }
        // Try keyboard: ArrowDown → Enter (selects first suggestion without needing CSS selector)
        if (!cityCode) {
          await page.keyboard.press("ArrowDown");
          await page.waitForTimeout(400);
          await page.keyboard.press("Enter");
          await page.waitForTimeout(2500);
          const urlNow = page.url();
          console.log("DEBUG_URL_AFTER_CITY_SELECT:", urlNow.slice(0, 200));
          const um = urlNow.match(/[?&]city=(\d+)/);
          if (um) { cityCode = um[1]; console.log("DEBUG_CITY_CODE_URL:", cityCode); }
        }
        break;
      } catch {}
    }

    // Final URL check
    const m = page.url().match(/[?&]city=(\d+)/);
    if (m && !cityCode) cityCode = m[1];

    page.off("response", handler);
  }

  if (cityCode) {
    console.log("DEBUG_CITY_CODE:", cityCode, "| navigating to city-filtered URL");
    await page.goto(
      `https://www.yad2.co.il/realestate/rent?city=${cityCode}`,
      { waitUntil: "domcontentloaded", timeout: 45000 }
    );
    await page.waitForTimeout(2500);
    return true;
  }

  console.log("DEBUG_CITY_FILTER_NOT_APPLIED: city code not found, will filter by listing text");
  return false;
}

async function applyShelterFilter(page) {
  const selectors = [
    'label:has-text("מקלט")', 'text=מקלט',
    '[data-test*="shelter"]',   '[class*="shelter"]',
    'input[value*="shelter"]',  'input[value*="מקלט"]',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0) === 0) continue;
    try {
      const tag = await loc.evaluate(el => el.tagName.toLowerCase()).catch(() => "");
      if (tag === "input") {
        if (!await loc.isChecked().catch(() => false)) await loc.click({ timeout: 3000 });
      } else {
        await loc.click({ timeout: 3000 });
      }
      await page.waitForTimeout(1500);
      console.log("DEBUG_SHELTER_FILTER_APPLIED");
      return true;
    } catch {}
  }
  console.log("DEBUG_SHELTER_FILTER_NOT_FOUND: will filter by listing text instead");
  return false;
}

async function applyRoomFilter(page, minRooms, maxRooms) {
  if (!minRooms && !maxRooms) return;
  try {
    const minSel = '[placeholder*="מ-חדרים"], [data-test*="min-rooms"], [class*="min-rooms"]';
    const maxSel = '[placeholder*="עד-חדרים"], [data-test*="max-rooms"], [class*="max-rooms"]';
    const minI = page.locator(minSel).first();
    const maxI = page.locator(maxSel).first();
    if (minRooms && await minI.count().catch(() => 0) > 0) {
      await minI.fill(String(minRooms)); await page.waitForTimeout(400);
    }
    if (maxRooms && await maxI.count().catch(() => 0) > 0) {
      await maxI.fill(String(maxRooms)); await page.waitForTimeout(400);
    }
    console.log("DEBUG_ROOMS_FILTER_APPLIED:", minRooms, "-", maxRooms);
  } catch {}
}

// ── Yad2 city code map ─────────────────────────────────────────────────────────
const CITY_CODE_MAP = {
  "תל אביב":           "5000",
  "תל אביב יפו":       "5000",
  "ירושלים":           "3000",
  "חיפה":              "4000",
  "באר שבע":           "9000",
  "נתניה":             "7400",
  "פתח תקווה":         "7900",
  "ראשון לציון":       "8300",
  "אשדוד":             "70",
  "אשקלון":            "2650",
  "חולון":             "6100",
  "בני ברק":           "6200",
  "רמת גן":            "8600",
  "הרצליה":            "6400",
  "כפר סבא":           "6900",
  "רחובות":            "8400",
  "פרדס חנה":          "7800",
  "פרדס חנה-כרכור":   "7800",
};

function resolveYad2CityCode(cityHebrew) {
  if (!cityHebrew) return null;
  if (CITY_CODE_MAP[cityHebrew]) return CITY_CODE_MAP[cityHebrew];
  for (const [name, code] of Object.entries(CITY_CODE_MAP)) {
    if (cityHebrew.includes(name) || name.includes(cityHebrew)) return code;
  }
  return null;
}

// ── Yad2 API-based scan (no browser) ───────────────────────────────────────────
const YAD2_API_BASE = "https://www.yad2.co.il/api/pre-load/getFeedIndex/realestate/rent";
const YAD2_HEADERS  = {
  "accept":          "application/json, text/plain, */*",
  "accept-language": "he,en-US;q=0.9,en;q=0.8",
  "referer":         "https://www.yad2.co.il/realestate/rent",
  "user-agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "sec-fetch-dest":  "empty",
  "sec-fetch-mode":  "cors",
  "sec-fetch-site":  "same-origin",
};

async function fetchYad2API(cfg) {
  const cityCode = resolveYad2CityCode(cfg.city_hebrew);
  if (!cityCode) {
    console.log("WARN_YAD2_API: no city code for", cfg.city_hebrew, "— skipping Yad2");
    return [];
  }

  const params = { city: cityCode };
  if (cfg.rooms_min) params.minRooms = String(cfg.rooms_min);
  if (cfg.rooms_max) params.maxRooms = String(cfg.rooms_max);
  if (cfg.price_max_ils) params.maxPrice = String(cfg.price_max_ils);

  const items = [];
  // ScraperAPI free tier: 1000 credits/month, render=true costs 5 credits each → cap at 3 pages (=15 credits/run)
  const MAX_PAGES = SCRAPER_API_KEY ? 3 : 10;
  // Reuse same proxy IP+cookies across pages so ShieldSquare session from page 1 carries to page 2+
  const scraperSession = SCRAPER_API_KEY ? Math.floor(Math.random() * 9000) + 1000 : null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await new Promise(r => setTimeout(r, 5000));
    params.page = String(page);
    const url = `${YAD2_API_BASE}?${new URLSearchParams(params)}`;
    console.log("DEBUG_YAD2_API_PAGE:", page);

    let data;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let resp, text;
        if (SCRAPER_API_KEY) {
          // Route through ScraperAPI — handles ShieldSquare anti-bot
          // session_number keeps same IP+cookies across pages so ShieldSquare session persists
          const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&render=true&session_number=${scraperSession}`;
          resp = await fetch(scraperUrl);
          text = await resp.text();
        } else if (GMAIL_SCRIPT_URL) {
          // Route through Google Apps Script via GET to avoid Render IP block
          const proxyUrl = `${GMAIL_SCRIPT_URL}?action=fetchYad2&params=${encodeURIComponent(new URLSearchParams(params).toString())}`;
          resp = await fetch(proxyUrl);
          text = await resp.text();
        } else {
          resp = await fetch(url, { headers: YAD2_HEADERS });
          if (!resp.ok) { console.log("WARN_YAD2_API_STATUS:", resp.status); break; }
          text = await resp.text();
        }
        if (text.trimStart().startsWith("<")) {
          console.log("WARN_YAD2_API_HTML_RESPONSE: attempt", attempt + 1, "|", text.slice(0, 120).replace(/\s+/g, " "));
          if (attempt < 2) { await new Promise(r => setTimeout(r, 4000)); continue; }
          break;
        }
        data = JSON.parse(text);
        break;
      } catch (e) {
        console.log("WARN_YAD2_API_FETCH_ERR:", String(e)); break;
      }
    }
    if (!data) break;

    const feedItems = data?.feed?.feed_items;
    if (!feedItems || feedItems.length === 0) break;

    let foundAds = 0;
    for (const item of feedItems) {
      if (item.type !== "ad" && item.type !== "advanced_ad") continue;
      foundAds++;

      const hasShelter = typeof item.mamad_text === "string" && item.mamad_text.includes('ממ"ד');
      if (cfg.require_shelter !== false && !hasShelter) continue;

      const rooms = item.Rooms ? parseFloat(item.Rooms) : null;
      if (rooms !== null) {
        if (cfg.rooms_min && rooms < cfg.rooms_min) continue;
        if (cfg.rooms_max && rooms > cfg.rooms_max) continue;
      }

      const listingUrl = item.link_token
        ? `https://www.yad2.co.il/item/${item.link_token}`
        : null;
      if (!listingUrl) continue;

      const price = item.price ? Number(item.price) : null;
      if (price && cfg.price_max_ils && price > cfg.price_max_ils) continue;
      items.push({
        dedupe_key:          makeDedupeKey("yad2", listingUrl),
        platform:            "yad2",
        url:                 listingUrl,
        title:               item.row_2 || item.city || "(no title)",
        priceText:           price ? `${price.toLocaleString("he-IL")} ₪` : null,
        rooms:               rooms !== null ? String(rooms) : null,
        city:                item.city || cfg.city_hebrew,
        hasShelter,
        description_snippet: item.row_2 || null,
        image_urls:          Array.isArray(item.images_urls) ? item.images_urls.slice(0, 3) : [],
        contact:             item.contact_name || null,
      });
    }

    console.log(`DEBUG_YAD2_API_PAGE_${page}: ads=${foundAds} matched=${items.length}`);

    const totalPages = data?.feed?.total_pages;
    if (!totalPages || page >= totalPages) break;
  }

  console.log("DEBUG_YAD2_API_TOTAL:", items.length);
  return items;
}

// ── Yad2 realestate scan (browser-based, kept for reference) ───────────────────
async function scanYad2Apartments(context, cfg) {
  const page = await context.newPage();
  const candidateUrls = [];
  const seenUrls = new Set();

  const jsonBuffers = [];
  page.on("response", async (resp) => {
    try {
      if (!resp.url().includes("yad2")) return;
      const ct = resp.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      const data = await resp.json().catch(() => null);
      if (data) jsonBuffers.push(data);
    } catch {}
  });

  try {
    console.log("DEBUG_YAD2_APT: navigating to realestate/rent");
    await page.goto("https://www.yad2.co.il/realestate/rent", {
      waitUntil: "domcontentloaded", timeout: 45000,
    });
    await page.waitForTimeout(3000);

    const bodyText  = (await page.textContent("body").catch(() => "")) || "";
    const pageTitle = await page.title().catch(() => "");
    if (looksBotOrOops(bodyText, pageTitle)) {
      console.log("WARN_BOT_ON_YAD2_REALESTATE");
      return [];
    }

    // Apply filters
    await applyCityFilter(page, cfg.city_hebrew);
    if (cfg.require_shelter !== false) await applyShelterFilter(page);
    await applyRoomFilter(page, cfg.rooms_min, cfg.rooms_max);

    // Wait for results and scroll
    await page.waitForTimeout(3000);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {});
      await page.waitForTimeout(900);
    }

    // DOM URLs
    const domUrls = await extractApartmentUrlsFromDom(page);
    console.log("DEBUG_YAD2_DOM_URLS:", domUrls.length);

    // JSON-derived IDs
    const shelterIds = new Set();
    const allIds     = new Set();
    for (const data of jsonBuffers) {
      for (const id of extractListingIdsFromJson(data, true,  cfg.city_hebrew)) shelterIds.add(id);
      for (const id of extractListingIdsFromJson(data, false, cfg.city_hebrew)) allIds.add(id);
    }
    console.log("DEBUG_YAD2_JSON_SHELTER_IDS:", shelterIds.size, "| ALL_IDS:", allIds.size);

    // Combine: DOM first, then JSON
    for (const url of domUrls) {
      if (!seenUrls.has(url) && isGoodApartmentUrl(url)) {
        seenUrls.add(url); candidateUrls.push(url);
      }
    }
    // Prefer shelter-confirmed JSON IDs, then fall back to all IDs if few results
    const idsToAdd = shelterIds.size >= 5 ? shelterIds : new Set([...shelterIds, ...allIds]);
    for (const id of idsToAdd) {
      const url = `https://www.yad2.co.il/item/${id}`;
      if (!seenUrls.has(url)) { seenUrls.add(url); candidateUrls.push(url); }
    }

    console.log("DEBUG_YAD2_CANDIDATES:", candidateUrls.length);
  } finally {
    await page.close().catch(() => {});
  }

  return candidateUrls;
}

// ── Fetch apartment listing details ───────────────────────────────────────────
async function fetchApartmentDetails(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500 + Math.floor(Math.random() * 800));

    let bodyText = (await page.textContent("body").catch(() => "")) || "";
    if (bodyText.trim().length < 50) {
      await page.waitForTimeout(1500);
      bodyText = (await page.textContent("body").catch(() => "")) || "";
    }

    const pageTitle = await page.title().catch(() => "");
    if (looksBotOrOops(bodyText, pageTitle)) {
      return { skip: true, skipReason: "BOT_CHECK" };
    }
    if (bodyText.includes("אין לנו עמוד כזה") || bodyText.includes("חיפשנו בכל מקום") ||
        bodyText.includes("הדף לא נמצא") || bodyText.includes("404 Not Found")) {
      return { skip: true, skipReason: "PAGE_NOT_FOUND" };
    }

    const title =
      (await page.locator("h1").first().textContent().catch(() => null))?.trim() ||
      pageTitle || "";

    const priceText =
      (await page.locator('[class*="price"], [data-test*="price"]').first().textContent().catch(() => null))?.trim() ||
      (bodyText.match(/₪\s?\d[\d,\.]*/)?.[0] ?? "");

    const city =
      (await page.locator('[class*="city"], [class*="location"], [class*="address"], [data-test*="location"]').first().textContent().catch(() => null))?.trim() ||
      null;

    const desc =
      (await page.locator('[class*="description"], [data-test*="description"]').first().textContent().catch(() => null))?.trim() ||
      bodyText.replace(/\s+/g, " ").trim().slice(0, 1000);

    // Check visible text AND aria-labels / titles / data attributes (Yad2 uses icons)
    const shelterInAttrs = await page.evaluate(() => {
      const sel = [
        '[aria-label*="מקלט"]', '[title*="מקלט"]', '[alt*="מקלט"]',
        '[aria-label*="ממד"]',  '[title*="ממד"]',
        '[aria-label*="shelter"]', '[data-key*="shelter"]', '[data-key*="mamad"]',
        '[class*="shelter"]', '[class*="mamad"]',
      ].join(",");
      return document.querySelectorAll(sel).length > 0;
    }).catch(() => false);
    const hasShelter = looksLikeShelter(`${title} ${bodyText.slice(0, 3000)}`) || shelterInAttrs;

    // Room count
    const roomMatch =
      bodyText.match(/(\d(?:[.,]\d)?)\s*חדרים/) ||
      bodyText.match(/(\d(?:[.,]\d)?)\s*חד'/)   ||
      title.match(/(\d(?:[.,]\d)?)\s*חדרים/);
    const rooms = roomMatch ? roomMatch[1] : null;

    const phone = bodyText.match(/(\+972|0)\s?-?\d{1,2}\s?-?\d{3}\s?-?\d{4}/)?.[0] ?? null;

    const imageUrls = await page.evaluate(() => {
      const seen = new Set(); const out = [];
      for (const img of Array.from(document.images)) {
        const u = img.currentSrc || img.src;
        if (!u || !u.startsWith("http")) continue;
        if (u.includes("logo") || u.includes("icon")) continue;
        if (seen.has(u)) continue;
        seen.add(u); out.push(u);
        if (out.length >= 6) break;
      }
      return out;
    }).catch(() => []);

    return {
      title,
      priceText: priceText || null,
      rooms,
      city,
      description_snippet: desc.replace(/\s+/g, " ").trim().slice(0, 400),
      image_urls: imageUrls,
      contact: phone,
      hasShelter,
    };
  } catch (e) {
    console.log("WARN_FETCH_APT_ERROR:", String(e).slice(0, 120));
    return { skip: true, skipReason: "FETCH_ERROR" };
  }
}

// ── Facebook apartment scan ────────────────────────────────────────────────────
async function scanFacebookApartments(context, cfg) {
  const city        = cfg.city_hebrew;
  const shelterWord = cfg.require_shelter !== false ? " מקלט" : "";
  const terms = [
    `דירה להשכרה${shelterWord} ${city}`,
    `להשכרה${shelterWord} ${city}`,
    `דירה ${city}${shelterWord}`,
  ];

  const searchPage = await context.newPage();
  const out        = [];
  const seenKeys   = new Set();

  function detectLoginWall(page) {
    const u = page.url();
    return u.includes("/login") || u.includes("checkpoint") || u.includes("recover");
  }

  try {
    // ── Marketplace ────────────────────────────────────────────────────────
    console.log("DEBUG_FB_APT: starting Marketplace scan");
    for (const term of terms) {
      const url = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(term)}&exact=false`;
      console.log("DEBUG_FB_APT_MARKETPLACE:", term);

      try {
        await searchPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      } catch (e) {
        console.log("WARN_FB_MARKETPLACE_TIMEOUT:", term); continue;
      }
      await searchPage.waitForTimeout(2000 + Math.floor(Math.random() * 1000));

      if (detectLoginWall(searchPage)) {
        console.log("WARN_FB_SESSION_EXPIRED: stopping Marketplace scan");
        return out;
      }

      await searchPage.evaluate(() => window.scrollBy(0, 900)).catch(() => {});
      await searchPage.waitForTimeout(1200);

      const listings = await searchPage.$$eval('a[href*="/marketplace/item/"]', as => {
        const seen = new Set();
        const results = [];
        for (const a of as) {
          const m = a.href.match(/(https?:\/\/www\.facebook\.com\/marketplace\/item\/\d+)/);
          if (!m) continue;
          const url = m[1] + "/";
          if (seen.has(url)) continue;
          seen.add(url);
          // Walk up to find the card container and get its text
          let el = a;
          for (let i = 0; i < 6; i++) {
            if (!el.parentElement) break;
            el = el.parentElement;
          }
          results.push({ url, cardText: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200) });
        }
        return results;
      }).catch(() => []);

      console.log("DEBUG_FB_APT_MARKETPLACE_LINKS:", listings.length);

      for (const { url: itemUrl, cardText } of listings.slice(0, 10)) {
        // Filter by full city name in card text
        if (city && cardText && !cardText.includes(city)) {
          console.log("DEBUG_FB_MARKETPLACE_WRONG_CITY:", cardText.slice(0, 60));
          continue;
        }
        // Filter by room count and price if detectable in card text
        if (!roomsInRange(cardText, cfg.rooms_min, cfg.rooms_max)) continue;
        if (!priceUnderMax(cardText, cfg.price_max_ils)) continue;
        const dkey = makeDedupeKey("facebook_marketplace", itemUrl);
        if (seenKeys.has(dkey)) continue;
        seenKeys.add(dkey);
        out.push({
          dedupe_key:          dkey,
          platform:            "facebook_marketplace",
          url:                 itemUrl,
          title:               `Marketplace — ${term}`,
          priceText:           null,
          rooms:               null,
          city,
          hasShelter:          cfg.require_shelter !== false,
          description_snippet: `(Facebook Marketplace: "${term}")`,
          image_urls:          [],
          contact:             null,
        });
      }
    }

    // ── Posts ──────────────────────────────────────────────────────────────
    console.log("DEBUG_FB_APT: starting Posts scan");
    for (const term of terms) {
      const url = `https://www.facebook.com/search/posts/?q=${encodeURIComponent(term)}`;
      console.log("DEBUG_FB_APT_POSTS:", term);

      try {
        await searchPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      } catch (e) {
        console.log("WARN_FB_POSTS_TIMEOUT:", term); continue;
      }
      await searchPage.waitForTimeout(2000 + Math.floor(Math.random() * 1000));

      if (detectLoginWall(searchPage)) {
        console.log("WARN_FB_SESSION_EXPIRED: stopping Posts scan");
        break;
      }

      await searchPage.evaluate(() => window.scrollBy(0, 900)).catch(() => {});
      await searchPage.waitForTimeout(1200);

      const posts = await searchPage.evaluate(() => {
        const results = []; const seen = new Set();
        for (const a of Array.from(document.querySelectorAll("a[href]"))) {
          const href = a.href || "";
          const isPost =
            /facebook\.com\/groups\/.+\/posts\//i.test(href) ||
            /facebook\.com\/[^/?]+\/posts\//i.test(href)     ||
            /facebook\.com\/permalink\.php/i.test(href)      ||
            /facebook\.com\/story\.php/i.test(href);
          if (!isPost) continue;
          let url;
          try { const u = new URL(href); u.search = ""; url = u.toString(); } catch { url = href; }
          if (seen.has(url)) continue;
          seen.add(url);

          // Extract group name from URL if it's a group post
          const groupMatch = url.match(/facebook\.com\/groups\/([^/]+)\//i);
          const groupId = groupMatch ? groupMatch[1] : null;

          // Find group name from nearby anchor text (group links in the article)
          let el = a;
          for (let i = 0; i < 6; i++) {
            if (!el.parentElement) break;
            el = el.parentElement;
            if (el.getAttribute("role") === "article") break;
          }
          const groupNameEl = el.querySelector(`a[href*="/groups/${groupId}"]`);
          const groupName = groupNameEl ? (groupNameEl.innerText || "").trim() : null;

          const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400);
          results.push({ url, text, groupId, groupName });
          if (results.length >= 15) break;
        }
        return results;
      }).catch(() => []);

      console.log("DEBUG_FB_APT_POSTS_FOUND:", posts.length);

      for (const { url: postUrl, text, groupId, groupName } of posts) {
        // Skip broken hash-fragment URLs (not real post links)
        if (!postUrl || postUrl.includes("#?") || !postUrl.startsWith("http")) continue;

        // Skip garbage content: repeated "Facebook", scrambled metadata, or notification UI text
        const fbRepeat = (text.match(/\bFacebook\b/gi) || []).length;
        const realWords = text.replace(/[a-z0-9]{20,}/gi, "").trim().split(/\s+/).length;
        const isNotifJunk = /NotificationsAll|push notifications are off|rising fan|earned a top fan/i.test(text);
        if (fbRepeat > 5 || realWords < 6 || isNotifJunk) continue;

        // City filter — skip posts that don't mention the city
        const cityWord = (city || "").split(/[\s\-]+/).find(w => w.length >= 2) || city;
        if (cityWord && !text.includes(cityWord)) continue;

        // Room count and price filter
        if (!roomsInRange(text, cfg.rooms_min, cfg.rooms_max)) continue;
        if (!priceUnderMax(text, cfg.price_max_ils)) continue;

        const groupUrl = groupId
          ? `https://www.facebook.com/groups/${groupId}/`
          : null;

        // Dedupe by group URL if available (avoids duplicate group recommendations)
        const dkey = makeDedupeKey("facebook_posts", groupUrl || postUrl);
        if (seenKeys.has(dkey)) continue;
        seenKeys.add(dkey);

        // Extract price from post text and filter if above max
        const priceMatch = text.match(/(\d[\d,]{2,})\s*(?:₪|ש"ח|שח|שקל)/);
        const postPrice  = priceMatch ? parseInt(priceMatch[1].replace(/,/g, "")) : null;
        if (postPrice && cfg.price_max_ils && postPrice > cfg.price_max_ils) continue;

        out.push({
          dedupe_key:          dkey,
          platform:            "facebook_posts",
          url:                 groupUrl || postUrl,
          title:               groupName ? `קבוצה: ${groupName}` : `פוסט פייסבוק — ${term}`,
          priceText:           postPrice ? `${postPrice.toLocaleString("he-IL")} ₪` : null,
          rooms:               null,
          city,
          hasShelter:          looksLikeShelter(text),
          description_snippet: text.slice(0, 350),
          image_urls:          [],
          contact:             null,
          group_name:          groupName || groupId || null,
          group_url:           groupUrl,
        });
      }
    }
  } finally {
    await searchPage.close().catch(() => {});
  }

  console.log("DEBUG_FB_APT_TOTAL:", out.length);
  return out;
}

// ── Gmail ──────────────────────────────────────────────────────────────────────
async function sendEmail(subject, text, toEmail) {
  if (!GMAIL_SCRIPT_URL) {
    console.log("WARN: GMAIL_SCRIPT_URL not set — skipping email");
    return;
  }
  const to = toEmail || NOTIFY_EMAIL;
  if (!to) { console.log("WARN: no recipient email — skipping email"); return; }
  console.log("DEBUG_EMAIL: sending to", to);
  const res = await fetch(GMAIL_SCRIPT_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ to, subject, body: text }),
  });
  const txt = await res.text();
  if (txt !== "ok") throw new Error("Script replied: " + txt);
  console.log("DEBUG_EMAIL: sent OK");
}

// ── Main ───────────────────────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.log("FATAL_UNHANDLED_REJECTION:", String(reason));
  process.exitCode = 1;
});

(async () => {
  const ts  = nowLocalISO();
  const cfg = loadConfig();
  console.log("=== Apartment Watch run started:", ts, "===");
  console.log("CONFIG:", JSON.stringify(cfg));

  const openedUrls  = [];
  const skipReasons = new Map();
  const recordOpened = (platform, url) => openedUrls.push({ platform, url, at: Date.now() });
  const recordSkip   = (platform, url, reason) => {
    const key = `${platform}|${url}`;
    if (!skipReasons.has(key)) skipReasons.set(key, { reason });
  };

  // ── Yad2 scan (API — no browser) ───────────────────────────────────────────
  const allItems = [];
  try {
    const yad2Items = await fetchYad2API(cfg);
    for (const item of yad2Items) {
      recordOpened("yad2", item.url);
      allItems.push(item);
    }
  } catch (e) {
    console.log("WARN_YAD2_API_SCAN_FAILED:", String(e));
  }

  // ── Facebook scan ──────────────────────────────────────────────────────────
  if (fs.existsSync(FB_STORAGE_STATE)) {
    let fbBrowser;
    try {
      fbBrowser = await chromium.launch({
        channel: "chromium-headless-shell",
        args: [
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-extensions",
          "--single-process",
          "--js-flags=--max-old-space-size=128",
        ],
      });
      const fbCtx = await fbBrowser.newContext({
        storageState: FB_STORAGE_STATE,
        locale:       "he-IL",
        timezoneId:   "Asia/Jerusalem",
        viewport:     { width: 800, height: 600 },
      });
      await fbCtx.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (["image", "media", "font", "stylesheet"].includes(type)) return route.abort();
        route.continue();
      });
      const fbItems = await scanFacebookApartments(fbCtx, cfg);
      for (const fi of fbItems) { recordOpened(fi.platform, fi.url); allItems.push(fi); }
    } catch (e) {
      console.log("WARN_FB_APT_SCAN_FAILED:", String(e));
    } finally {
      if (fbBrowser) await fbBrowser.close().catch(() => {});
    }
  } else {
    console.log("INFO_FB: facebook-state.json not found — skipping FB scan. Run: node facebook-login.js");
  }

  // ── Dedupe ─────────────────────────────────────────────────────────────────
  const seenKeys = loadSeenKeys();
  const newItems = [];
  for (const it of allItems) {
    const key = it.dedupe_key;
    if (seenKeys.has(key)) { recordSkip(it.platform, it.url, "DEDUPED"); continue; }
    newItems.push(it);
    seenKeys.add(key);
  }
  saveSeenKeys(seenKeys);
  console.log("DEBUG_DEDUPE_BEFORE:", allItems.length, "| NEW:", newItems.length);

  // ── Email body ─────────────────────────────────────────────────────────────
  const bodyLines = [];
  if (newItems.length === 0) {
    bodyLines.push("No new apartments found this run.");
  } else {
    const shelterNote = cfg.require_shelter !== false ? " with מקלט" : "";
    bodyLines.push(`Found ${newItems.length} new apartment listings in ${cfg.city_hebrew}${shelterNote}:\n`);
    for (const it of newItems) {
      bodyLines.push(`[${it.platform}] ${it.title}`);
      if (it.priceText)           bodyLines.push(`  Price:   ${it.priceText}`);
      else if (it.platform === "yad2") bodyLines.push(`  Price:   ⚠ not listed in API — verify on site`);
      if (it.rooms)               bodyLines.push(`  Rooms:   ${it.rooms}`);
      if (it.city)                bodyLines.push(`  City:    ${it.city}`);
      if (it.contact)             bodyLines.push(`  Phone:   ${it.contact}`);
      bodyLines.push(`  Shelter: ${it.hasShelter ? "YES (מקלט confirmed)" : "not confirmed in text"}`);
      bodyLines.push(`  Link:    ${it.url}`);
      if (it.description_snippet) bodyLines.push(`  "${it.description_snippet.slice(0, 200)}"`);
      bodyLines.push("");
    }
  }

  const openedUniq = Array.from(
    new Map(openedUrls.map(o => [`${o.platform}|${o.url}`, o])).values()
  );
  const skipSummary = {};
  for (const { reason } of skipReasons.values()) {
    skipSummary[reason] = (skipSummary[reason] || 0) + 1;
  }
  bodyLines.push("=== Audit ===");
  bodyLines.push(`Opened URLs this run: ${openedUniq.length}`);
  bodyLines.push(`Skip summary: ${JSON.stringify(skipSummary)}`);

  const emailBody = bodyLines.join("\n");
  const subject   = newItems.length > 0
    ? `Apartment Watch (${cfg.city_hebrew}) — ${newItems.length} new listings — ${ts}`
    : `Apartment Watch (${cfg.city_hebrew}) — heartbeat — ${ts}`;

  const payload = {
    run_timestamp_local:  ts,
    run_status:           "ok",
    city:                 cfg.city_hebrew,
    new_count:            newItems.length,
    email_subject:        subject,
    email_body_plaintext: emailBody,
    items:                newItems,
    opened_urls:          openedUniq,
    skip_summary:         skipSummary,
  };

  console.log("\nEMAIL_SUBJECT:\n" + subject);
  console.log("\nEMAIL_BODY:\n" + emailBody);

  // ── Save results for UI display ────────────────────────────────────────────
  try {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch (e) {
    console.log("WARN_RESULTS_SAVE_FAILED:", String(e).slice(0, 80));
  }

  // ── Send email ─────────────────────────────────────────────────────────────
  const heartbeatDue = isHeartbeatDue();
  const shouldSend   = newItems.length > 0 || heartbeatDue;

  if (!shouldSend) {
    console.log("OK: No new items and heartbeat already sent today — skipping email");
  } else {
    try {
      await sendEmail(subject, emailBody, cfg.notify_email);
      markHeartbeatSent();
      console.log("OK: Email sent to", cfg.notify_email || NOTIFY_EMAIL);
    } catch (e) {
      console.log("WARN_EMAIL_FAILED:", String(e));
      process.exitCode = 1;
    }
  }

  console.log("=== Apartment Watch run complete:", nowLocalISO(), "===");
})();
