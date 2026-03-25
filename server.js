"use strict";

/**
 * Apartment Watch — REST API backend
 * Deploy to Render. Frontend lives separately on Vercel.
 */

const http       = require("http");
const fs         = require("fs");
const path       = require("path");
const { spawn }  = require("child_process");

const PORT        = process.env.PORT || 3456;
const CONFIG_PATH = path.join(__dirname, "apartment-config.json");
const RESULTS_PATH  = path.join(__dirname, "last-results.json");
const FB_STATE_PATH = path.join(__dirname, "facebook-state.json");
const ZAPIER_URL    = process.env.ZAPIER_WEBHOOK_URL || "";

// ── CORS ───────────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── Config helpers ─────────────────────────────────────────────────────────────
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return { city_hebrew: "", rooms_min: 2, rooms_max: 4, price_max_ils: 8000, require_shelter: true }; }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// ── SSE / scraper ──────────────────────────────────────────────────────────────
let activeLogLines = [];
let sseClients     = [];
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

function runScraper() {
  if (runInProgress) return false;
  runInProgress  = true;
  activeLogLines = [];

  const env   = Object.assign({}, process.env, { ZAPIER_WEBHOOK_URL: ZAPIER_URL });
  const child = spawn(process.execPath, [path.join(__dirname, "apartment-watch.js")], {
    cwd: __dirname,
    env,
  });

  child.stdout.on("data", d => String(d).split("\n").forEach(l => { if (l) broadcastLog(l); }));
  child.stderr.on("data", d => String(d).split("\n").forEach(l => { if (l) broadcastLog("ERR: " + l); }));
  child.on("close", code => {
    broadcastLog(`\n=== Process exited (code ${code}) ===`);
    broadcastDone();
    runInProgress = false;
  });
  return true;
}

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, `http://localhost:${PORT}`);

  // GET /api/config
  if (req.method === "GET" && u.pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readConfig()));
    return;
  }

  // POST /api/config
  if (req.method === "POST" && u.pathname === "/api/config") {
    const body = await parseJsonBody(req);
    writeConfig(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/results
  if (req.method === "GET" && u.pathname === "/api/results") {
    try {
      const data = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no results yet" }));
    }
    return;
  }

  // GET /api/status
  if (req.method === "GET" && u.pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ running: runInProgress }));
    return;
  }

  // POST /api/run
  if (req.method === "POST" && u.pathname === "/api/run") {
    if (runInProgress) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "already running" }));
      return;
    }
    const body = await parseJsonBody(req);
    if (body && Object.keys(body).length > 0) writeConfig(body);
    runScraper();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/log-stream  (SSE)
  if (req.method === "GET" && u.pathname === "/api/log-stream") {
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

  // GET /api/facebook-status
  if (req.method === "GET" && u.pathname === "/api/facebook-status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hasSession: fs.existsSync(FB_STATE_PATH) }));
    return;
  }

  // POST /api/facebook-session
  if (req.method === "POST" && u.pathname === "/api/facebook-session") {
    const body = await parseJsonBody(req);
    try {
      JSON.parse(body.content);
      fs.writeFileSync(FB_STATE_PATH, body.content, "utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid" }));
    }
    return;
  }

  // Health check
  if (req.method === "GET" && u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});
