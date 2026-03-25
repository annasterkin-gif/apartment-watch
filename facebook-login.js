"use strict";

/**
 * Run this ONCE manually to save your Facebook session:
 *   node facebook-login.js
 *
 * After that, apartment-watch.js will use facebook-state.json automatically.
 * Re-run if Facebook ever logs you out (session expires ~90 days).
 */

const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale:     "he-IL",
    timezoneId: "Asia/Jerusalem",
    viewport:   { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  await page.goto("https://www.facebook.com", { waitUntil: "domcontentloaded" });

  console.log("=================================================");
  console.log("Log into Facebook in the browser window.");
  console.log("Complete any 2FA if prompted.");
  console.log("Once you can see your Feed, press ENTER here.");
  console.log("=================================================");

  process.stdin.resume();
  await new Promise(resolve => process.stdin.once("data", resolve));

  const statePath = path.join(__dirname, "facebook-state.json");
  await context.storageState({ path: statePath });
  console.log("Session saved to", statePath);
  console.log("You can close the browser window.");

  await browser.close();
  process.exit(0);
})();
