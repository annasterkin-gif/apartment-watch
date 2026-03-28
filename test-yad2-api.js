"use strict";
// Run: node test-yad2-api.js

const BASE = "https://www.yad2.co.il/api/pre-load/getFeedIndex/realestate/rent";

async function main() {
  const headers = {
    "accept":          "application/json, text/plain, */*",
    "accept-language": "he,en-US;q=0.9,en;q=0.8",
    "referer":         "https://www.yad2.co.il/realestate/rent",
    "user-agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "sec-fetch-dest":  "empty",
    "sec-fetch-mode":  "cors",
    "sec-fetch-site":  "same-origin",
  };

  // 1. Show key fields of first listing
  console.log("=== Key fields from first listing ===");
  const r1 = await fetch(BASE, { headers });
  const d1 = await r1.json();
  const first = d1.feed.feed_items.find(i => i.type === "ad");
  console.log("id:", first.id, "| link_token:", first.link_token);
  console.log("price:", first.price, "| currency:", first.currency);
  console.log("city:", first.city, "| city_code:", first.city_code);
  console.log("Rooms:", first.Rooms, "| mamad_text:", first.mamad_text);

  // 2. Show search_params from the API (reveals valid filter keys)
  console.log("\n=== search_params from API ===");
  console.log(JSON.stringify(d1.feed.search_params, null, 2));

  // 3. Try filter variations
  const filterSets = [
    { label: "Yad2 URL style",    params: { city: "7700", minRooms: "2", maxRooms: "3", maxPrice: "5000" } },
    { label: "priceRange style",  params: { cityCode: "7700", priceRange: "0-5000", roomsRange: "2-3" } },
    { label: "topAreaId",         params: { topAreaId: "7", minRooms: "2", maxRooms: "3", maxPrice: "5000" } },
    { label: "area_id",           params: { area_id: "7700", minRooms: "2", maxRooms: "3", maxPrice: "5000" } },
  ];

  console.log("\n=== Filter attempts ===");
  for (const { label, params } of filterSets) {
    const p = new URLSearchParams({ ...params, page: "1" });
    const r = await fetch(`${BASE}?${p}`, { headers });
    const d = await r.json();
    console.log(`${label}: total_items=${d.feed?.total_items}`);
  }

  // 4. Show a few city_code values to find פרדס חנה code
  console.log("\n=== City codes in current page ===");
  const ads = d1.feed.feed_items.filter(i => i.type === "ad" || i.type === "advanced_ad");
  const cityMap = {};
  for (const a of ads) {
    if (a.city && a.city_code) cityMap[a.city] = a.city_code;
  }
  console.log(JSON.stringify(cityMap, null, 2));
}

main().catch(console.error);
