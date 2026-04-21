const express = require("express");
const cors = require("cors");
require("dotenv").config();

console.log("=== PartTensor Backend Starting ===");
console.log("Anthropic:", process.env.ANTHROPIC_API_KEY ? "OK" : "MISSING");
console.log("Gemini:", process.env.GEMINI_API_KEY ? "OK" : "MISSING");
console.log("DigiKey:", process.env.DIGIKEY_CLIENT_ID ? "OK" : "MISSING");
console.log("Mouser:", process.env.MOUSER_API_KEY ? "OK" : "MISSING");
console.log("Supabase:", process.env.SUPABASE_URL ? "OK" : "MISSING");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// =============================================
// PLAN LIMITS
// =============================================
var PLANS = {
  guest:      { messages: 5,    bom: false, excel: false, history: false, api: false },
  free:       { messages: 20,   bom: false, excel: false, history: true,  api: false },
  pro:        { messages: 9999, bom: true,  excel: true,  history: true,  api: false },
  team:       { messages: 9999, bom: true,  excel: true,  history: true,  api: false },
  enterprise: { messages: 9999, bom: true,  excel: true,  history: true,  api: true  },
  paid:       { messages: 9999, bom: true,  excel: true,  history: true,  api: false },
};

var PRICES = {
  pro_monthly:  19900,
  pro_yearly:   179900,
  team_monthly: 99900,
  team_yearly:  899900,
};

var stockCache = {};
var aiCache = {};
var STOCK_TTL = 2 * 60 * 60 * 1000;
var AI_TTL = 6 * 60 * 60 * 1000;

function getCached(cache, key) {
  var entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.time > entry.ttl) { delete cache[key]; return null; }
  return entry.data;
}
function setCache(cache, key, data, ttl) {
  cache[key] = { data: data, time: Date.now(), ttl: ttl };
}

// =============================================
// SUPABASE
// =============================================
async function supabaseQuery(method, table, body, params) {
  try {
    var fetch = (await import("node-fetch")).default;
    var url = process.env.SUPABASE_URL + "/rest/v1/" + table;
    if (params) url += "?" + params;
    var res = await fetch(url, {
      method: method || "GET",
      headers: {
        "Content-Type": "application/json",
        "apikey": process.env.SUPABASE_KEY,
        "Authorization": "Bearer " + process.env.SUPABASE_KEY,
        "Prefer": method === "POST" ? "return=minimal" : "return=representation",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      var err = await res.text();
      console.error("Supabase error:", res.status, err.substring(0, 200));
      return null;
    }
    if (method === "POST" && res.status === 201) return true;
    var text = await res.text();
    return text ? JSON.parse(text) : true;
  } catch (e) { console.error("Supabase failed:", e.message); return null; }
}

// =============================================
// BEHAVIOUR TRACKING
// =============================================
async function trackSearch(userId, sessionId, plan, query, componentType, resultsCount, source) {
  try {
    // Update user session
    var today = new Date().toISOString().split("T")[0];
    if (sessionId) {
      var existing = await supabaseQuery("GET", "user_sessions", null, "session_id=eq." + encodeURIComponent(sessionId) + "&select=id,searches_count");
      if (existing && existing.length > 0) {
        await supabaseQuery("PATCH", "user_sessions", { searches_count: (existing[0].searches_count || 0) + 1, last_active: new Date().toISOString(), plan: plan || "guest" }, "id=eq." + existing[0].id);
      } else {
        await supabaseQuery("POST", "user_sessions", { user_id: userId || null, session_id: sessionId, plan: plan || "guest", searches_count: 1, last_active: new Date().toISOString() });
      }
    }
    // Update daily analytics
    var analytics = await supabaseQuery("GET", "daily_analytics", null, "date=eq." + today + "&select=id,total_searches,total_users,guest_searches,free_searches,pro_searches,top_queries");
    var planField = (plan === "pro" || plan === "paid" || plan === "team" || plan === "enterprise") ? "pro_searches" : plan === "free" ? "free_searches" : "guest_searches";
    if (analytics && analytics.length > 0) {
      var rec = analytics[0];
      var topQueries = rec.top_queries || {};
      topQueries[query] = (topQueries[query] || 0) + 1;
      var updates = { total_searches: (rec.total_searches || 0) + 1, top_queries: topQueries };
      updates[planField] = (rec[planField] || 0) + 1;
      await supabaseQuery("PATCH", "daily_analytics", updates, "id=eq." + rec.id);
    } else {
      var newRec = { date: today, total_searches: 1, total_users: 1, guest_searches: 0, free_searches: 0, pro_searches: 0, top_queries: {} };
      newRec[planField] = 1;
      newRec.top_queries[query] = 1;
      await supabaseQuery("POST", "daily_analytics", newRec);
    }
  } catch (e) { console.error("trackSearch failed:", e.message); }
}

async function trackInteraction(data) {
  try {
    await supabaseQuery("POST", "interactions", {
      session_id: data.sessionId || "anon",
      query: data.query || "",
      component_type: data.componentType || "",
      required_voltage: data.requiredVoltage || null,
      required_current: data.requiredCurrent || null,
      part_number: data.partNumber || "",
      manufacturer: data.manufacturer || "",
      action: data.action || "",
      position: data.position || null,
      total_results: data.totalResults || null,
    });
    var score = 0;
    if (data.action === "buy_dk" || data.action === "buy_mouser") score = 10;
    else if (data.action === "datasheet") score = 5;
    else if (data.action === "card_click") score = 2;
    else if (data.action === "negative_feedback") score = -8;
    if (data.position && score > 0) score += (data.position - 1) * 2;
    var queryNorm = (data.query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var existing = await supabaseQuery("GET", "part_performance", null,
      "query_normalized=eq." + encodeURIComponent(queryNorm) +
      "&part_number=eq." + encodeURIComponent(data.partNumber || "") +
      "&select=id,buy_clicks,datasheet_clicks,card_clicks,total_score,search_count"
    );
    if (existing && existing.length > 0) {
      var rec = existing[0];
      var updates = { total_score: (rec.total_score || 0) + score, last_updated: new Date().toISOString() };
      if (data.action === "buy_dk" || data.action === "buy_mouser") updates.buy_clicks = (rec.buy_clicks || 0) + 1;
      else if (data.action === "datasheet") updates.datasheet_clicks = (rec.datasheet_clicks || 0) + 1;
      else if (data.action === "card_click") updates.card_clicks = (rec.card_clicks || 0) + 1;
      await supabaseQuery("PATCH", "part_performance", updates, "id=eq." + rec.id);
    } else {
      await supabaseQuery("POST", "part_performance", {
        query_normalized: queryNorm,
        component_type: data.componentType || "",
        required_voltage: data.requiredVoltage || null,
        required_current: data.requiredCurrent || null,
        part_number: data.partNumber || "",
        manufacturer: data.manufacturer || "",
        buy_clicks: (data.action === "buy_dk" || data.action === "buy_mouser") ? 1 : 0,
        datasheet_clicks: data.action === "datasheet" ? 1 : 0,
        card_clicks: data.action === "card_click" ? 1 : 0,
        alternative_searches: 0,
        negative_feedback: 0,
        total_score: score,
        search_count: 0,
        last_updated: new Date().toISOString(),
      });
    }
  } catch (e) { console.error("trackInteraction failed:", e.message); }
}

async function updatePartSearchCount(queryNorm, partNumber, position) {
  try {
    var existing = await supabaseQuery("GET", "part_performance", null,
      "query_normalized=eq." + encodeURIComponent(queryNorm) +
      "&part_number=eq." + encodeURIComponent(partNumber) +
      "&select=id,search_count,avg_position"
    );
    if (existing && existing.length > 0) {
      var rec = existing[0];
      var sc = (rec.search_count || 0) + 1;
      var avgPos = ((rec.avg_position || position) * (sc - 1) + position) / sc;
      await supabaseQuery("PATCH", "part_performance", {
        search_count: sc,
        avg_position: Math.round(avgPos * 10) / 10,
        last_search: new Date().toISOString(),
      }, "id=eq." + rec.id);
    } else {
      await supabaseQuery("POST", "part_performance", {
        query_normalized: queryNorm,
        part_number: partNumber,
        search_count: 1,
        avg_position: position,
        total_score: 0,
        buy_clicks: 0,
        datasheet_clicks: 0,
        card_clicks: 0,
        alternative_searches: 0,
        negative_feedback: 0,
        last_search: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      });
    }
  } catch (e) { /* non-critical */ }
}

async function getLearnedRankings(query, componentType) {
  try {
    var queryNorm = (query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var results = await supabaseQuery("GET", "part_performance", null,
      "query_normalized=eq." + encodeURIComponent(queryNorm) +
      "&total_score=gt.0&order=total_score.desc&limit=10&select=part_number,total_score,buy_clicks"
    );
    if (!results || results.length === 0) {
      if (componentType) {
        results = await supabaseQuery("GET", "part_performance", null,
          "component_type=eq." + encodeURIComponent(componentType) +
          "&total_score=gt.5&order=total_score.desc&limit=10&select=part_number,total_score,buy_clicks"
        );
      }
    }
    return results || [];
  } catch (e) { return []; }
}

function applyLearnedRanking(parts, learnedData) {
  if (!learnedData || learnedData.length === 0) return parts;
  var scoreMap = {};
  learnedData.forEach(function(r) { scoreMap[r.part_number] = r.total_score; });
  return parts.slice().sort(function(a, b) {
    return (scoreMap[b.partNumber] || 0) - (scoreMap[a.partNumber] || 0);
  });
}

async function getUserPlan(userId) {
  if (!userId) return "guest";
  try {
    var result = await supabaseQuery("GET", "usage_limits", null,
      "identifier=eq." + encodeURIComponent(userId) + "&select=plan"
    );
    if (result && result.length > 0) return result[0].plan || "free";
    return "free";
  } catch (e) { return "free"; }
}

// =============================================
// DIGIKEY
// =============================================
var digikeyToken = null;
var digikeyTokenExpiry = null;
var digikeyTokenRefreshPromise = null;

async function getDigikeyToken() {
  if (digikeyToken && digikeyTokenExpiry && Date.now() < digikeyTokenExpiry) return digikeyToken;
  if (digikeyTokenRefreshPromise) return digikeyTokenRefreshPromise;
  digikeyTokenRefreshPromise = (async function() {
    var fetch = (await import("node-fetch")).default;
    try {
      var res = await fetch("https://api.digikey.com/v1/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.DIGIKEY_CLIENT_ID, client_secret: process.env.DIGIKEY_CLIENT_SECRET }),
      });
      var data = await res.json();
      if (data.access_token) {
        digikeyToken = data.access_token;
        digikeyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
        console.log("DigiKey token refreshed");
        digikeyTokenRefreshPromise = null;
        return digikeyToken;
      }
      digikeyTokenRefreshPromise = null;
      return null;
    } catch (e) { console.error("DigiKey token failed:", e.message); digikeyTokenRefreshPromise = null; return null; }
  })();
  return digikeyTokenRefreshPromise;
}


async function lookupDigikey(mpn) {
  try {
    var cached = getCached(stockCache, "dk_" + mpn);
    if (cached) return cached;
    var fetch = (await import("node-fetch")).default;
    var token = await getDigikeyToken();
    if (!token) return null;
    var res = await fetch(
      "https://api.digikey.com/products/v4/search/" + encodeURIComponent(mpn) + "/productdetails",
      { method: "GET", headers: { "Authorization": "Bearer " + token, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD" } }
    );
    if (!res.ok) {
      var res2 = await fetch("https://api.digikey.com/products/v4/search/keyword", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD", "Content-Type": "application/json" },
        body: JSON.stringify({ Keywords: mpn, Limit: 3, Offset: 0 }),
      });
      if (!res2.ok) return null;
      var d2 = await res2.json();
      var prods = d2.Products || [];
      if (prods.length === 0) return null;
      var best2 = prods.reduce(function(a, b) { return (b.QuantityAvailable || 0) > (a.QuantityAvailable || 0) ? b : a; });
      var p2 = best2.UnitPrice || (best2.StandardPricing && best2.StandardPricing[0] && best2.StandardPricing[0].UnitPrice) || null;
      var r2 = { found: true, stock: best2.QuantityAvailable || 0, price: p2 ? "$" + parseFloat(p2).toFixed(3) : null, url: best2.ProductUrl || "", matchedMPN: best2.ManufacturerProductNumber || mpn };
      setCache(stockCache, "dk_" + mpn, r2, STOCK_TTL);
      return r2;
    }
    var data = await res.json();
    var product = data.Product || data;
    var unitPrice = product.UnitPrice || (product.StandardPricing && product.StandardPricing[0] && product.StandardPricing[0].UnitPrice) || null;
    var result = { found: true, stock: product.QuantityAvailable || 0, price: unitPrice ? "$" + parseFloat(unitPrice).toFixed(3) : null, url: product.ProductUrl || "", matchedMPN: product.ManufacturerProductNumber || mpn };
    setCache(stockCache, "dk_" + mpn, result, STOCK_TTL);
    return result;
  } catch (e) { console.error("DK lookup failed:", mpn, e.message); return null; }
}

async function lookupMouser(mpn) {
  try {
    var cached = getCached(stockCache, "mo_" + mpn);
    if (cached) return cached;
    var fetch = (await import("node-fetch")).default;
    var res = await fetch("https://api.mouser.com/api/v1/search/partnumber?apiKey=" + process.env.MOUSER_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: "Begins With" } }),
    });
    var data = res.ok ? await res.json() : null;
    var parts = (data && data.SearchResults && data.SearchResults.Parts) || [];
    if (parts.length === 0) return null;
    var best = parts.reduce(function(a, b) {
      return (parseInt((b.Availability || "0").replace(/[^0-9]/g, "")) || 0) > (parseInt((a.Availability || "0").replace(/[^0-9]/g, "")) || 0) ? b : a;
    });
    var stock = parseInt((best.Availability || "0").replace(/[^0-9]/g, "")) || 0;
    var price = best.PriceBreaks && best.PriceBreaks[0] && best.PriceBreaks[0].Price;
    var result = { found: stock > 0, stock: stock, price: price || null, url: best.ProductDetailUrl || "" };
    setCache(stockCache, "mo_" + mpn, result, STOCK_TTL);
    return result;
  } catch (e) { console.error("Mouser lookup failed:", mpn, e.message); return null; }
}

async function fetchStock(mpn) {
  var results = await Promise.all([lookupDigikey(mpn), lookupMouser(mpn)]);
  var dk = results[0]; var mo = results[1];
  var total = (dk ? dk.stock : 0) + (mo ? mo.stock : 0);
  var bestPrice = null, bestPriceSource = null;
  if (dk && dk.price) { bestPrice = dk.price; bestPriceSource = "Digi-Key"; }
  if (mo && mo.price) {
    var mv = parseFloat((mo.price || "999").replace(/[^0-9.]/g, "")) || 999;
    var cv = parseFloat((bestPrice || "999").replace(/[^0-9.]/g, "")) || 999;
    if (mv < cv) { bestPrice = mo.price; bestPriceSource = "Mouser"; }
  }
  return { found: total > 0, totalStock: total, bestPrice: bestPrice, bestPriceSource: bestPriceSource, digikey: dk, mouser: mo, octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(mpn) };
}

// =============================================
// GEMINI - Suggests part numbers using Google Search
// DigiKey only used for stock + price verification
// =============================================
async function searchPartsWithGemini(query, componentType, requiredSpecs) {
  try {
    var fetch = (await import("node-fetch")).default;
    console.log("Gemini search:", query);

    var specsHint = "";
    if (requiredSpecs.voltage) specsHint += " voltage>=" + requiredSpecs.voltage + "V";
    if (requiredSpecs.current) specsHint += " current>=" + requiredSpecs.current + "A";
    if (requiredSpecs.capacitanceUF) specsHint += " capacitance~" + requiredSpecs.capacitanceUF + "uF";
    if (requiredSpecs.inductanceUH) specsHint += " inductance~" + requiredSpecs.inductanceUH + "uH";

    // Step 1: Let Gemini search freely and think like an engineer
    var researchPrompt = "I need to find the best electronic components for this request: " + query + (specsHint ? " Required specs:" + specsHint : "") + ". Please search DigiKey and Mouser right now and find the 4 best matching parts. For each part tell me: exact manufacturer part number, manufacturer name, key specs, package, why it is a good choice, and any cautions. Focus on parts that are currently in stock and from reputable manufacturers like Infineon, Vishay, ON Semi, TI, STMicro, Rohm, Renesas, Omron, TE Connectivity, Panasonic, Murata, Wurth, Kemet.";

    var res1 = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + process.env.GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: researchPrompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
        }),
      }
    );

    if (!res1.ok) {
      var errText = await res1.text();
      console.error("Gemini research error:", res1.status, errText.substring(0, 300));
      return null;
    }

    var data1 = await res1.json();
    var candidates1 = data1.candidates || [];
    if (candidates1.length === 0) return null;
    var researchText = ((candidates1[0].content && candidates1[0].content.parts) || []).map(function(p) { return p.text || ""; }).join("");
    console.log("Gemini research (500):", researchText.substring(0, 500));

    if (!researchText || researchText.length < 100) return null;

    // Step 2: Use Claude to extract structured JSON from Gemini's research
    // This is more reliable than asking Gemini to output JSON directly
    var claudePrompt = "Extract electronic parts from this research into JSON. CRITICAL RULES: 1) Only include parts with a REAL manufacturer part number (MPN) - reject any part where the MPN is TBD, N/A, Example, or contains only words without numbers. 2) Only include parts explicitly mentioned in the research with a specific MPN. 3) If fewer than 4 real MPNs exist in the research, only return those that are real. Return ONLY the JSON object, no markdown.\n\nRESEARCH:\n" + researchText.substring(0, 3000) + "\n\nJSON format:\n{\"category\":\"Connector\",\"interpretation\":\"one sentence\",\"designTip\":\"one tip\",\"results\":[{\"partNumber\":\"REAL_MPN_WITH_NUMBERS\",\"manufacturer\":\"Name\",\"type\":\"Type\",\"keySpecs\":[{\"label\":\"Pins\",\"value\":\"10\",\"unit\":\"\"},{\"label\":\"Current\",\"value\":\"5\",\"unit\":\"A\"},{\"label\":\"Pitch\",\"value\":\"2\",\"unit\":\"mm\"},{\"label\":\"Stack Height\",\"value\":\"12\",\"unit\":\"mm\"}],\"package\":\"SMD\",\"rank\":\"top\",\"aeComment\":\"Specific reason why this fits\",\"caution\":null,\"applications\":[\"Board to Board\"]}]}";

    var claudeStruct = await callClaude("You extract electronic component data from research text into JSON. Return ONLY valid JSON, no markdown, no explanation, no text before or after the JSON object.", [{ role: "user", content: claudePrompt }], 3000);

    if (!claudeStruct.text) { console.error("Claude struct extraction failed"); return null; }
    console.log("Structured response (300):", claudeStruct.text.substring(0, 300));

    var clean = claudeStruct.text.replace(/```json/gi, "").replace(/```/g, "").trim();
    var depth = 0, start = -1, end = -1;
    for (var i = 0; i < clean.length; i++) {
      if (clean[i] === "{") { if (depth === 0) start = i; depth++; }
      else if (clean[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (start === -1 || end === -1) { console.error("No JSON in struct response"); return null; }

    try {
      var parsed = JSON.parse(clean.substring(start, end + 1));
      if (parsed && parsed.results && parsed.results.length > 0) {
        console.log("Final parts (Gemini+Claude):", parsed.results.map(function(p) { return p.partNumber; }).join(", "));
        return parsed;
      }
      return null;
    } catch (e) { console.error("Struct JSON parse failed:", e.message); return null; }
  } catch (e) { console.error("Gemini failed:", e.message); return null; }
}

// =============================================
// SPEC VALIDATION - Check Gemini results before returning
// =============================================
function validateSpecsFromJSON(parts, requiredSpecs) {
  if (!requiredSpecs || Object.keys(requiredSpecs).length === 0) return parts;
  if (!parts || parts.length === 0) return parts;

  var passed = [];
  var failed = [];

  parts.forEach(function(part) {
    var keySpecs = part.keySpecs || [];
    var partVoltage = null;
    var partCurrent = null;
    var partCap = null;
    var partInd = null;

    keySpecs.forEach(function(spec) {
      var label = (spec.label || "").toLowerCase();
      var val = parseFloat(spec.value);
      if (isNaN(val)) return;
      var unit = (spec.unit || "").toLowerCase();

      // Voltage
      if (label === "vds" || label === "vce" || label === "vrrm" || label === "vr" ||
          label === "voltage" || label === "coil voltage" || label === "working voltage" ||
          label.includes("volt") && !label.includes("gate") && !label.includes("threshold")) {
        if (!partVoltage) partVoltage = val;
      }
      // Current
      if (label === "id" || label === "ic" || label === "if" || label === "iout" ||
          label === "current" || label === "contact current" || label === "rated current" ||
          label.includes("current") && !label.includes("quies")) {
        if (!partCurrent) {
          if (unit === "ma") partCurrent = val / 1000;
          else partCurrent = val;
        }
      }
      // Capacitance
      if (label === "capacitance" || label === "cap" || label === "c") {
        if (!partCap) {
          if (unit === "nf") partCap = val / 1000;
          else if (unit === "pf") partCap = val / 1000000;
          else partCap = val; // assume uF
        }
      }
      // Inductance
      if (label === "inductance" || label === "l") {
        if (!partInd) {
          if (unit === "nh") partInd = val / 1000;
          else if (unit === "mh") partInd = val * 1000;
          else partInd = val; // assume uH
        }
      }
    });

    var issues = [];

    // Check voltage
    if (requiredSpecs.voltage && partVoltage !== null) {
      if (partVoltage < requiredSpecs.voltage * 0.95) {
        issues.push("voltage " + partVoltage + "V < required " + requiredSpecs.voltage + "V");
      }
    }
    // Check current
    if (requiredSpecs.current && partCurrent !== null) {
      if (partCurrent < requiredSpecs.current * 0.95) {
        issues.push("current " + partCurrent + "A < required " + requiredSpecs.current + "A");
      }
    }
    // Check capacitance (within 30%)
    if (requiredSpecs.capacitanceUF && partCap !== null) {
      if (Math.abs(partCap - requiredSpecs.capacitanceUF) / requiredSpecs.capacitanceUF > 0.30) {
        issues.push("capacitance " + partCap + "uF != required " + requiredSpecs.capacitanceUF + "uF");
      }
    }
    // Check inductance (within 30%)
    if (requiredSpecs.inductanceUH && partInd !== null) {
      if (Math.abs(partInd - requiredSpecs.inductanceUH) / requiredSpecs.inductanceUH > 0.30) {
        issues.push("inductance " + partInd + "uH != required " + requiredSpecs.inductanceUH + "uH");
      }
    }

    if (issues.length > 0) {
      console.log("  SPEC FAIL:", part.partNumber, issues.join(", "));
      failed.push(part);
    } else {
      console.log("  SPEC OK:", part.partNumber, "voltage:", partVoltage, "current:", partCurrent);
      passed.push(part);
    }
  });

  console.log("Spec validation: " + passed.length + " passed, " + failed.length + " failed");

  // If less than 2 passed - return all (better than nothing)
  if (passed.length < 2) {
    console.log("Too few passed spec check - returning all parts");
    return parts;
  }
  return passed;
}

// =============================================
// CLAUDE
// =============================================
async function callClaude(system, messages, maxTokens) {
  var fetch = (await import("node-fetch")).default;
  var models = ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"];
  for (var attempt = 1; attempt <= 3; attempt++) {
    var model = attempt <= 2 ? models[0] : models[1];
    try {
      var aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: model, max_tokens: maxTokens || 3000, system: system, messages: messages }),
      });
      var aiData = await aiRes.json();
      if (aiData.error && aiData.error.type === "overloaded_error") { await new Promise(function(r) { setTimeout(r, attempt * 3000); }); continue; }
      if (aiData.error) return { error: aiData.error.message };
      return { text: (aiData.content || []).map(function(b) { return b.text || ""; }).join("") };
    } catch (err) { if (attempt < 3) await new Promise(function(r) { setTimeout(r, 2000); }); }
  }
  return { error: "All retries failed." };
}

function extractJSON(text) {
  var clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  var depth = 0, start = -1, end = -1;
  for (var i = 0; i < clean.length; i++) {
    if (clean[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (clean[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(clean.substring(start, end + 1)); } catch (e) { return null; }
}

function extractPartNumber(text) {
  var m1 = text.match(/\b([A-Z]{1,6}[0-9]{2,}[A-Z0-9\-]*)\b/gi) || [];
  var m2 = text.match(/\b([0-9]+[\-][0-9A-Z][\-0-9A-Z]*)\b/gi) || [];
  var all = m1.concat(m2).filter(function(m) { return m.length >= 4; });
  if (all.length === 0) return null;
  return all.sort(function(a, b) { return b.length - a.length; })[0];
}

function extractRequiredSpecs(query) {
  var lower = query.toLowerCase(); var specs = {};
  var vM = lower.match(/(\d+(?:\.\d+)?)\s*v\b/gi) || [];
  if (vM.length > 0) { var vs = vM.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; }); if (vs.length > 0) specs.voltage = Math.max.apply(null, vs); }
  var aM = lower.match(/(\d+(?:\.\d+)?)\s*a\b/gi) || [];
  if (aM.length > 0) { var as2 = aM.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; }); if (as2.length > 0) specs.current = Math.max.apply(null, as2); }
  var ufM = lower.match(/(\d+(?:\.\d+)?)\s*uf\b/gi) || [];
  if (ufM.length > 0) specs.capacitanceUF = parseFloat(ufM[0]);
  var uhM = lower.match(/(\d+(?:\.\d+)?)\s*uh\b/gi) || [];
  if (uhM.length > 0) specs.inductanceUH = parseFloat(uhM[0]);
  return specs;
}

function detectComponentType(query) {
  var q = query.toLowerCase();
  if (q.includes("relay")) return "relay";
  if (q.includes("mosfet") || q.includes(" fet")) return q.includes("p-channel") ? "mosfet_p" : "mosfet_n";
  if (q.includes("igbt")) return "igbt";
  if (q.includes("schottky")) return "diode_schottky";
  if (q.includes("zener")) return "diode_zener";
  if (q.includes("diode") || q.includes("rectifier")) return "diode";
  if (q.includes("capacitor") || q.match(/\d+\s*(uf|nf|pf)\b/)) return "capacitor";
  if (q.includes("inductor") || q.match(/\d+\s*(uh|nh|mh)\b/)) return "inductor";
  if (q.includes("resistor")) return "resistor";
  if (q.includes("op-amp") || q.includes("opamp")) return "opamp";
  if (q.includes("ldo") || q.includes("linear regulator")) return "ldo";
  if (q.includes("transistor") || q.includes("bjt")) return "bjt";
  if (q.includes("gate driver")) return "gate_driver";
  if (q.includes("sensor")) return "sensor";
  if (q.includes("connector")) return "connector";
  return null;
}

var COMPONENT_KEYWORDS = ["relay","mosfet","capacitor","resistor","inductor","diode","transistor","op-amp","opamp","ldo","regulator","sensor","connector","switch","fuse","crystal","oscillator","driver","controller","igbt","thyristor","triac","optocoupler","transformer","ic","chip","bjt","scr","module","rectifier","varistor","thermistor","potentiometer","encoder","solenoid","motor driver","gate driver","voltage reference","comparator","adc","dac","mux","buffer","schottky","zener","fet"];

function isComponentQuery(message) {
  var lower = message.toLowerCase();
  for (var i = 0; i < COMPONENT_KEYWORDS.length; i++) { if (lower.includes(COMPONENT_KEYWORDS[i])) return true; }
  return false;
}

// =============================================
// SYSTEM PROMPTS
// =============================================
var INTENT_SYSTEM = "You classify hardware engineering queries. RULES:\n1. ANY message mentioning a component name MUST be 'part_search': relay, MOSFET, capacitor, resistor, inductor, diode, transistor, op-amp, LDO, regulator, sensor, connector, IC, BJT, IGBT, FET, schottky, zener.\n2. 'circuit_question' only if asking HOW something works with NO component request.\n3. 'calculation' only if asking to calculate a value.\n4. 'general' only if completely unrelated to electronics.\n5. Follow-up refinements keep SAME intent.\nRespond ONLY with JSON: {\"intent\":\"part_search|find_alternatives|generate_bom|circuit_question|calculation|correction|general\",\"partNumber\":null,\"needsMoreInfo\":false,\"followUpQuestion\":null}";

var ENGINEERING_SYSTEM = "You are PartTensor, a senior hardware application engineer AI. Help engineers with component selection, circuit design, calculations, and troubleshooting. Be direct, technical and precise. Format with **bold headers** and - bullet points.";

var CLAUDE_PART_SYSTEM = "You are a senior hardware application engineer. Suggest EXACTLY 4 real electronic parts.\nRULES: Only parts that EXIST on DigiKey. Meet or exceed all specs. For relays match coil voltage exactly. Use: Infineon, Vishay, ON Semi, TI, STMicro, Rohm, Renesas, Omron, TE Connectivity, Panasonic, Murata, Wurth, Kemet. 4 keySpecs each.\nRespond ONLY with raw JSON:\n{\"category\":\"Type\",\"interpretation\":\"summary\",\"designTip\":\"tip\",\"results\":[{\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"type\":\"Type\",\"keySpecs\":[{\"label\":\"L\",\"value\":\"V\",\"unit\":\"U\"}],\"package\":\"PKG\",\"rank\":\"top\",\"aeComment\":\"comment\",\"caution\":null,\"applications\":[\"app\"]}]}";

var ALT_SEARCH_SYSTEM = "Find EXACTLY 4 drop-in alternatives. Meet/exceed original specs. Different manufacturers. Must exist on DigiKey. 4 keySpecs each.\nRespond ONLY with raw JSON:\n{\"originalPart\":\"MPN\",\"originalSpecs\":\"specs\",\"alternatives\":[{\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"type\":\"Type\",\"compatibility\":\"drop-in\",\"keySpecs\":[{\"label\":\"L\",\"value\":\"V\",\"unit\":\"U\"}],\"package\":\"PKG\",\"whyAlternative\":\"reason\",\"differences\":\"diffs\"}],\"importantNote\":\"note\"}";

var BOM_SYSTEM = "Generate a complete BOM. Include ALL critical components: power semiconductors, gate drivers, control ICs, regulators, current sensors, bulk capacitors, power inductors, optocouplers, crystals, connectors. NO generic bypass caps. Use exact DigiKey MPNs.\nRespond ONLY with raw JSON:\n{\"projectName\":\"name\",\"description\":\"sentence\",\"voltage\":\"V\",\"power\":\"W\",\"designNotes\":\"notes\",\"totalEstimate\":\"$X-Y\",\"bomItems\":[{\"id\":1,\"function\":\"fn\",\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"description\":\"desc\",\"category\":\"IC\",\"quantity\":1,\"keySpecs\":\"specs\",\"package\":\"PKG\",\"priority\":\"critical\",\"unitPrice\":\"$X\",\"notes\":null}]}";

// =============================================
// HEALTH
// =============================================
app.get("/api/health", function(req, res) {
  res.json({ status: "ok", service: "PartTensor", gemini: !!process.env.GEMINI_API_KEY, time: new Date().toISOString() });
});

// =============================================
// ANALYTICS ENDPOINT
// =============================================
app.get("/api/analytics", async function(req, res) {
  try {
    var days = parseInt(req.query.days) || 7;
    var analytics = await supabaseQuery("GET", "daily_analytics", null, "order=date.desc&limit=" + days + "&select=*");
    var topParts = await supabaseQuery("GET", "part_performance", null, "total_score=gt.0&order=total_score.desc&limit=10&select=part_number,manufacturer,component_type,buy_clicks,total_score,search_count");
    var totalUsers = await supabaseQuery("GET", "user_sessions", null, "select=count");
    res.json({ analytics: analytics || [], topParts: topParts || [], totalUsers: totalUsers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// TRACK
// =============================================
app.post("/api/track", async function(req, res) {
  try {
    var data = req.body;
    if (!data.action || !data.partNumber) return res.json({ ok: false });
    await trackInteraction(data);
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

// =============================================
// FEEDBACK
// =============================================
app.post("/api/feedback", async function(req, res) {
  try {
    var partNumber = req.body.partNumber; var feedback = req.body.feedback;
    if (!partNumber || !feedback) return res.status(400).json({ error: "Required fields missing" });
    var score = feedback === "good" ? 5 : -10;
    var queryNorm = (req.body.query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var existing = await supabaseQuery("GET", "part_performance", null,
      "query_normalized=eq." + encodeURIComponent(queryNorm) + "&part_number=eq." + encodeURIComponent(partNumber) + "&select=id,total_score,negative_feedback"
    );
    if (existing && existing.length > 0) {
      var updates = { total_score: (existing[0].total_score || 0) + score, last_updated: new Date().toISOString() };
      if (feedback === "bad") updates.negative_feedback = (existing[0].negative_feedback || 0) + 1;
      await supabaseQuery("PATCH", "part_performance", updates, "id=eq." + existing[0].id);
    } else {
      await supabaseQuery("POST", "part_performance", { query_normalized: queryNorm, component_type: req.body.componentType || "", part_number: partNumber, manufacturer: req.body.manufacturer || "", total_score: score, negative_feedback: feedback === "bad" ? 1 : 0, buy_clicks: 0, datasheet_clicks: 0, card_clicks: 0, alternative_searches: 0, search_count: 0, last_updated: new Date().toISOString() });
    }
    if (feedback === "bad") {
      var ce = await supabaseQuery("GET", "part_catalog", null, "part_number=eq." + encodeURIComponent(partNumber) + "&select=id,negative_count");
      if (ce && ce.length > 0) { var nc = (ce[0].negative_count || 0) + 1; await supabaseQuery("PATCH", "part_catalog", { negative_count: nc, suppressed: nc >= 3 }, "id=eq." + ce[0].id); }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// STOCK BULK
// =============================================
app.post("/api/stock-bulk", async function(req, res) {
  try {
    var partNumbers = req.body.partNumbers || [];
    if (partNumbers.length === 0) return res.json({});
    var stockResults = await Promise.all(partNumbers.map(function(pn) { return fetchStock(pn); }));
    var stockMap = {};
    partNumbers.forEach(function(pn, i) { stockMap[pn] = stockResults[i]; });
    res.json(stockMap);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// EXCEL BOM (Pro+)
// =============================================
app.post("/api/excel-bom", express.raw({ type: "*/*", limit: "10mb" }), async function(req, res) {
  try {
    var fileContent = req.body.toString("utf8");
    var lines = fileContent.split("\n").filter(function(l) { return l.trim(); });
    if (lines.length === 0) return res.status(400).json({ error: "Empty file" });
    var headers = lines[0].split(",").map(function(h) { return h.replace(/"/g, "").trim().toLowerCase(); });
    var pnColIdx = 0;
    var pnKeywords = ["part number","pn","mpn","part no","partno","part#","component","part_number","manufacturer part"];
    for (var ki = 0; ki < pnKeywords.length; ki++) { for (var hi = 0; hi < headers.length; hi++) { if (headers[hi].indexOf(pnKeywords[ki]) !== -1) { pnColIdx = hi; break; } } }
    var descColIdx = -1;
    var descKeywords = ["description","desc","value","specification","spec","details","part name"];
    for (var di = 0; di < descKeywords.length; di++) { for (var hi2 = 0; hi2 < headers.length; hi2++) { if (headers[hi2].indexOf(descKeywords[di]) !== -1 && hi2 !== pnColIdx) { descColIdx = hi2; break; } } }
    var qtyColIdx = -1;
    var qtyKeywords = ["qty","quantity","count","amount","pcs"];
    for (var qi = 0; qi < qtyKeywords.length; qi++) { for (var hi3 = 0; hi3 < headers.length; hi3++) { if (headers[hi3].indexOf(qtyKeywords[qi]) !== -1) { qtyColIdx = hi3; break; } } }
    var bomRows = [];
    for (var li = 1; li < lines.length; li++) {
      var cols = lines[li].split(",").map(function(c) { return c.replace(/"/g, "").trim(); });
      if (cols[pnColIdx]) bomRows.push({ partNumber: cols[pnColIdx], description: descColIdx >= 0 ? (cols[descColIdx] || "") : "", quantity: qtyColIdx >= 0 ? (parseInt(cols[qtyColIdx]) || 1) : 1 });
    }
    if (bomRows.length === 0) return res.status(400).json({ error: "No part numbers found" });
    var results = [];
    var limit = Math.min(bomRows.length, 30);
    for (var pi = 0; pi < limit; pi++) {
      var row = bomRows[pi];
      var stock = await fetchStock(row.partNumber);
      var result = { partNumber: row.partNumber, description: row.description, quantity: row.quantity, stock: stock.totalStock || 0, bestPrice: stock.bestPrice || "", dkStock: stock.digikey ? stock.digikey.stock : 0, mousStock: stock.mouser ? stock.mouser.stock : 0, alt1: "", alt2: "", alt3: "" };
      try {
        var altRes = await callClaude(ALT_SEARCH_SYSTEM, [{ role: "user", content: "Find alternatives for " + row.partNumber + (row.description ? " (" + row.description + ")" : "") }], 2000);
        var altParsed = altRes.text ? extractJSON(altRes.text) : null;
        if (altParsed && altParsed.alternatives) {
          var alts = altParsed.alternatives.slice(0, 3);
          if (alts[0]) result.alt1 = alts[0].partNumber + " (" + alts[0].manufacturer + ")";
          if (alts[1]) result.alt2 = alts[1].partNumber + " (" + alts[1].manufacturer + ")";
          if (alts[2]) result.alt3 = alts[2].partNumber + " (" + alts[2].manufacturer + ")";
        }
      } catch (e) { console.error("Alt lookup failed:", row.partNumber); }
      results.push(result);
    }
    var csvHeaders = ["Part Number","Description","Quantity","Total Stock","Best Price","Digi-Key Stock","Mouser Stock","Alternative 1","Alternative 2","Alternative 3"];
    var csvRows = results.map(function(r) { return [r.partNumber, r.description, r.quantity, r.stock, r.bestPrice, r.dkStock, r.mousStock, r.alt1, r.alt2, r.alt3]; });
    var csv = [csvHeaders].concat(csvRows).map(function(row) { return row.map(function(c) { return '"' + String(c || "").replace(/"/g, '""') + '"'; }).join(","); }).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=BOM_PartTensor.csv");
    res.send(csv);
  } catch (err) { console.error("Excel BOM error:", err.message); res.status(500).json({ error: "Failed to process file: " + err.message }); }
});

// =============================================
// RAZORPAY
// =============================================
app.post("/api/create-order", async function(req, res) {
  try {
    var planKey = req.body.planKey || "pro_monthly";
    var amount = PRICES[planKey];
    if (!amount) return res.status(400).json({ error: "Invalid plan" });
    var Razorpay = require("razorpay");
    var rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    var order = await rzp.orders.create({ amount: amount, currency: "INR", receipt: "pt_" + Date.now(), notes: { userId: req.body.userId || "", planKey: planKey, email: req.body.email || "" } });
    res.json({ orderId: order.id, amount: amount, currency: "INR", planKey: planKey });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/verify-payment", async function(req, res) {
  try {
    var crypto = require("crypto");
    var expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "").update(req.body.razorpay_order_id + "|" + req.body.razorpay_payment_id).digest("hex");
    if (expected !== req.body.razorpay_signature) return res.status(400).json({ error: "Verification failed" });
    var userId = req.body.userId;
    var planKey = req.body.planKey || "pro_monthly";
    var planName = planKey.startsWith("team") ? "team" : planKey.startsWith("enterprise") ? "enterprise" : "pro";
    var expiresAt = new Date();
    if (planKey.includes("yearly")) expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    else expiresAt.setMonth(expiresAt.getMonth() + 1);
    if (userId) {
      var ex = await supabaseQuery("GET", "usage_limits", null, "identifier=eq." + encodeURIComponent(userId) + "&select=id");
      if (ex && ex.length > 0) await supabaseQuery("PATCH", "usage_limits", { plan: planName, message_count: 0, last_reset: new Date().toISOString().split("T")[0] }, "id=eq." + ex[0].id);
      else await supabaseQuery("POST", "usage_limits", { identifier: userId, identifier_type: "user", message_count: 0, last_reset: new Date().toISOString().split("T")[0], plan: planName });
      await supabaseQuery("POST", "payments", { user_id: userId, plan: planKey, status: "active", razorpay_payment_id: req.body.razorpay_payment_id, razorpay_order_id: req.body.razorpay_order_id, expires_at: expiresAt.toISOString() });
    }
    res.json({ success: true, plan: planName, planKey: planKey, expiresAt: expiresAt.toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/check-plan", async function(req, res) {
  try {
    var userId = req.body.userId;
    if (!userId) return res.json({ plan: "guest", limits: PLANS.guest });
    var plan = await getUserPlan(userId);
    res.json({ plan: plan, limits: PLANS[plan] || PLANS.free });
  } catch (err) { res.json({ plan: "free", limits: PLANS.free }); }
});

// =============================================
// MAIN CHAT
// =============================================
app.post("/api/chat", async function(req, res) {
  try {
    var message = req.body.message;
    var history = req.body.history || [];
    var sessionId = req.body.sessionId || "anon";
    var userId = req.body.userId || null;
    var clientPlan = req.body.plan || "guest";
    if (!message) return res.status(400).json({ error: "Message is required" });
    console.log("\n[CHAT]", message.substring(0, 80));

    // Get real plan from DB
    var plan = clientPlan;
    if (userId) plan = await getUserPlan(userId);
    var planLimits = PLANS[plan] || PLANS.guest;
    console.log("Plan:", plan, "BOM:", planLimits.bom);

    // USAGE LIMITS
    var identifier = userId || (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown");
    if (!planLimits.messages || planLimits.messages < 9999) {
      try {
        var today = new Date().toISOString().split("T")[0];
        var usageRes = await supabaseQuery("GET", "usage_limits", null, "identifier=eq." + encodeURIComponent(identifier) + "&select=id,message_count,last_reset,plan");
        var usage = usageRes && usageRes[0];
        if (usage) {
          if (usage.last_reset !== today) {
            await supabaseQuery("PATCH", "usage_limits", { message_count: 1, last_reset: today }, "id=eq." + usage.id);
          } else {
            var count = (usage.message_count || 0) + 1;
            if (count > planLimits.messages) {
              return res.json({ error: "Daily limit reached", limitReached: true, plan: plan });
            }
            await supabaseQuery("PATCH", "usage_limits", { message_count: count }, "id=eq." + usage.id);
          }
        } else {
          await supabaseQuery("POST", "usage_limits", { identifier: identifier, identifier_type: userId ? "user" : "ip", message_count: 1, last_reset: today, plan: plan });
        }
      } catch (e) { console.error("Usage check failed:", e.message); }
    }

    var requiredSpecs = extractRequiredSpecs(message);
    var componentType = detectComponentType(message);

    // Intent classification
    var contextSummary = history.slice(-6).map(function(m) { return (m.role === "user" ? "User: " : "AI: ") + (m.content || "").substring(0, 150); }).join("\n");
    var intentInput = history.length > 0 ? "Previous:\n" + contextSummary + "\n\nNew message: " + message : message;
    var intentResult = await callClaude(INTENT_SYSTEM, [{ role: "user", content: intentInput }], 300);
    var intent = "part_search"; var detectedPN = null;
    if (intentResult.text) { var ip = extractJSON(intentResult.text); if (ip) { intent = ip.intent || "part_search"; detectedPN = ip.partNumber || null; } }
    if (isComponentQuery(message) && intent === "general") intent = "part_search";
    console.log("Intent:", intent, "Component:", componentType, "Specs:", JSON.stringify(requiredSpecs));

    if (intent === "general") {
      return res.json({ text: "I am PartTensor, a hardware engineering AI. I can help you find electronic components, check live stock, generate BOMs, and answer circuit design questions. What component or design challenge can I help you with?", intent: intent, mode: "text" });
    }

    var fullMessages = [];
    history.slice(-8).forEach(function(m) { if (m.content) fullMessages.push({ role: m.role, content: m.content }); });
    fullMessages.push({ role: "user", content: message });

    // ENGINEERING QUESTIONS
    if (intent === "circuit_question" || intent === "calculation" || intent === "correction") {
      var engResult = await callClaude(ENGINEERING_SYSTEM, fullMessages, 2000);
      if (engResult.error) return res.status(503).json({ error: engResult.error });
      return res.json({ text: engResult.text, intent: intent, mode: "text" });
    }

    // FIND ALTERNATIVES
    if (intent === "find_alternatives") {
      var pn = detectedPN || extractPartNumber(message);
      if (!pn) return res.json({ text: "Could you specify the part number you want alternatives for?", intent: intent, mode: "question" });
      var altResult = await callClaude(ALT_SEARCH_SYSTEM, [{ role: "user", content: "Find alternatives for " + pn + ". Context: " + message }], 3000);
      var altData = altResult.text ? extractJSON(altResult.text) : null;
      if (!altData || !altData.alternatives) return res.json({ text: "Could not find alternatives for " + pn + ". Please try again.", intent: intent, mode: "text" });
      var altParts = altData.alternatives || [];
      var altStockResults = await Promise.all(altParts.map(function(p) { return fetchStock(p.partNumber); }));
      var altStockMap = {};
      altParts.forEach(function(p, i) { altStockMap[p.partNumber] = altStockResults[i]; });
      altParts.sort(function(a, b) { var aS = altStockMap[a.partNumber] ? altStockMap[a.partNumber].totalStock : 0; var bS = altStockMap[b.partNumber] ? altStockMap[b.partNumber].totalStock : 0; return (bS > 0 ? 1 : 0) - (aS > 0 ? 1 : 0) || bS - aS; });
      return res.json({ text: "Here are **" + altParts.length + " alternatives** for **" + pn + "** with live stock:", mode: "alt", originalPart: altData.originalPart || pn, originalSpecs: altData.originalSpecs || "", alternatives: altParts, stockData: altStockMap, importantNote: altData.importantNote || null, intent: intent, query: message, componentType: componentType, requiredVoltage: requiredSpecs.voltage || null, requiredCurrent: requiredSpecs.current || null });
    }

    // BOM - Pro+ only
    if (intent === "generate_bom") {
      if (!planLimits.bom) {
        return res.json({ text: "BOM generation is available on Pro and above.", intent: intent, mode: "upgrade", feature: "bom", requiredPlan: "pro" });
      }
      var bomCacheKey = "bom_" + message.toLowerCase().trim().substring(0, 80);
      var bomCached = getCached(aiCache, bomCacheKey);
      if (bomCached) return res.json(bomCached);
      var bomResult = await callClaude(BOM_SYSTEM, fullMessages, 4000);
      var bomData = bomResult.text ? extractJSON(bomResult.text) : null;
      if (!bomData || !bomData.bomItems) return res.json({ text: "Could you describe the application in more detail? Voltage, current, and key requirements?", intent: intent, mode: "question" });
      bomData.stockData = {};
      var bomResponse = Object.assign({ text: "Here is a complete BOM for **" + bomData.projectName + "** -- " + bomData.bomItems.length + " critical components. Stock loading...", intent: intent }, bomData);
      setCache(aiCache, bomCacheKey, bomResponse, AI_TTL);
      return res.json(bomResponse);
    }

    // PART SEARCH
    // Gemini suggests PNs using Google Search
    // DigiKey checks stock + price only (no spec rejection)
    var searchCacheKey = "search_" + message.toLowerCase().trim().substring(0, 80);
    var searchCached = getCached(aiCache, searchCacheKey);
    var parts = null; var searchMeta = {}; var source = "cache";

    if (searchCached) {
      console.log("Cache hit");
      parts = searchCached.results || [];
      searchMeta = { category: searchCached.category, interpretation: searchCached.interpretation, designTip: searchCached.designTip };
    } else {
      // Try Gemini with Google Search
      var geminiData = await searchPartsWithGemini(message, componentType, requiredSpecs);

      if (geminiData && geminiData.results && geminiData.results.length > 0) {
        parts = geminiData.results;
        searchMeta = { category: geminiData.category || componentType || "", interpretation: geminiData.interpretation || "", designTip: geminiData.designTip || "" };
        source = "gemini";
        console.log("Gemini suggested", parts.length, "parts");

        // Validate specs from Gemini JSON before accepting
        if (Object.keys(requiredSpecs).length > 0) {
          console.log("Validating Gemini specs against required:", JSON.stringify(requiredSpecs));
          var validated = validateSpecsFromJSON(parts, requiredSpecs);
          if (validated.length < parts.length) {
            console.log("Some parts failed spec check - retrying Gemini with stricter prompt...");
            var retryQuery = message + " IMPORTANT: All parts must meet these specs exactly: " +
              (requiredSpecs.voltage ? "voltage >= " + requiredSpecs.voltage + "V " : "") +
              (requiredSpecs.current ? "current >= " + requiredSpecs.current + "A " : "") +
              (requiredSpecs.capacitanceUF ? "capacitance = " + requiredSpecs.capacitanceUF + "uF " : "") +
              (requiredSpecs.inductanceUH ? "inductance = " + requiredSpecs.inductanceUH + "uH " : "");
            var retryData = await searchPartsWithGemini(retryQuery, componentType, requiredSpecs);
            if (retryData && retryData.results) {
              var retryValidated = validateSpecsFromJSON(retryData.results, requiredSpecs);
              if (retryValidated.length >= validated.length) {
                parts = retryValidated;
                console.log("Retry improved results:", parts.length, "valid parts");
              } else {
                parts = validated.length > 0 ? validated : parts;
              }
            } else {
              parts = validated.length > 0 ? validated : parts;
            }
          } else {
            parts = validated;
          }
        }
      } else {
        // Claude fallback
        console.log("Gemini failed, using Claude fallback...");
        var claudeResult = await callClaude(CLAUDE_PART_SYSTEM, fullMessages, 3000);
        var claudeData = claudeResult.text ? extractJSON(claudeResult.text) : null;
        if (!claudeData || !claudeData.results) {
          var fallback = await callClaude(ENGINEERING_SYSTEM, fullMessages, 1500);
          return res.json({ text: fallback.text || "Could not find specific parts. Please provide more details.", intent: intent, mode: "text" });
        }
        parts = claudeData.results;
        searchMeta = { category: claudeData.category || componentType || "", interpretation: claudeData.interpretation || "", designTip: claudeData.designTip || "" };
        source = "claude";
      }

      setCache(aiCache, searchCacheKey, Object.assign({ results: parts }, searchMeta), AI_TTL);
    }

    // Filter out obviously fake MPNs before stock lookup
    parts = parts.filter(function(part) {
      var pn = part.partNumber || "";
      // Reject if looks like placeholder text
      if (pn.length < 4) return false;
      if (pn === "TBD" || pn === "N/A" || pn === "EXAMPLE" || pn === "SAMPLE") return false;
      if (pn.toLowerCase().includes("contact ")) return false;
      if (pn.toLowerCase().includes("example")) return false;
      if (pn.toLowerCase().includes("constructed")) return false;
      if (/^[a-z\s]+$/i.test(pn) && !pn.match(/\d/)) return false; // all letters no numbers = not a real MPN
      return true;
    });
    console.log("After MPN filter:", parts.length, "valid parts");

    // Apply learned ranking from user behaviour
    var learnedData = await getLearnedRankings(message, componentType);
    if (learnedData.length > 0) {
      console.log("Applying learned ranking:", learnedData.length, "entries");
      parts = applyLearnedRanking(parts, learnedData);
    }

    // Fetch live stock + price from DigiKey + Mouser in parallel
    // This is the ONLY DigiKey call - for stock and price, not spec validation
    var stockPromises = parts.map(function(p) { return fetchStock(p.partNumber); });
    var stockResults = await Promise.all(stockPromises);
    var stockDataMap = {};
    parts.forEach(function(p, i) {
      stockDataMap[p.partNumber] = stockResults[i];
      // Correct MPN if DigiKey found a better match
      if (stockResults[i] && stockResults[i].digikey && stockResults[i].digikey.matchedMPN) {
        if (stockResults[i].digikey.matchedMPN !== p.partNumber && stockResults[i].digikey.matchedMPN.length > 3) {
          console.log("MPN corrected:", p.partNumber, "->", stockResults[i].digikey.matchedMPN);
          var newMPN = stockResults[i].digikey.matchedMPN;
          stockDataMap[newMPN] = stockDataMap[p.partNumber];
          p.partNumber = newMPN;
        }
      }
    });

    // Sort: in-stock first, then by quantity
    parts = parts.slice().sort(function(a, b) {
      var aS = stockDataMap[a.partNumber] ? stockDataMap[a.partNumber].totalStock : 0;
      var bS = stockDataMap[b.partNumber] ? stockDataMap[b.partNumber].totalStock : 0;
      return (bS > 0 ? 1 : 0) - (aS > 0 ? 1 : 0) || bS - aS;
    });

    // Track search behaviour in Supabase (non-blocking)
    var queryNorm = message.toLowerCase().trim().replace(/\s+/g, " ");
    trackSearch(userId, sessionId, plan, message, componentType, parts.length, source).catch(function() {});
    parts.forEach(function(p, i) {
      updatePartSearchCount(queryNorm, p.partNumber, i + 1).catch(function() {});
    });

    console.log("Returning", parts.length, "parts, source:", source);

    return res.json({
      text: "Found **" + parts.length + " parts** with live stock from Digi-Key and Mouser:",
      mode: "search",
      category: searchMeta.category || componentType || "",
      interpretation: searchMeta.interpretation || "",
      designTip: searchMeta.designTip || "",
      results: parts,
      stockData: stockDataMap,
      intent: intent,
      query: message,
      componentType: componentType,
      requiredVoltage: requiredSpecs.voltage || null,
      requiredCurrent: requiredSpecs.current || null,
      source: source,
    });

  } catch (err) {
    console.error("Chat error:", err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ error: "Server error: " + err.message });
  }
});

// Keep Render alive
setInterval(async function() {
  try { var fetch = (await import("node-fetch")).default; await fetch("https://parttensor-backend.onrender.com/api/health"); console.log("Keep-alive ping"); } catch (e) {}
}, 14 * 60 * 1000);

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log("\nPartTensor backend running on port " + PORT);
  console.log("Flow: Gemini (Google Search PNs) -> DigiKey (stock+price only) -> Claude fallback");
  console.log("Supabase: usage limits + interactions + part_performance + analytics + sessions\n");
});