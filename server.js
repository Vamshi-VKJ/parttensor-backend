const express = require("express");
const cors = require("cors");
require("dotenv").config();

console.log("=== PartTensor Backend Starting ===");
console.log("Anthropic:", process.env.ANTHROPIC_API_KEY ? "OK" : "MISSING");
console.log("Nexar:", process.env.NEXAR_CLIENT_ID ? "OK" : "MISSING");
console.log("Supabase:", process.env.SUPABASE_URL ? "OK" : "MISSING");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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

var partCache = {};
var aiCache = {};
var PART_TTL = 2 * 60 * 60 * 1000;  // 2hr for stock
var AI_TTL   = 24 * 60 * 60 * 1000; // 24hr for AI results

function getCached(cache, key) {
  var e = cache[key];
  if (!e) return null;
  if (Date.now() - e.time > e.ttl) { delete cache[key]; return null; }
  return e.data;
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
      headers: { "Content-Type": "application/json", "apikey": process.env.SUPABASE_KEY, "Authorization": "Bearer " + process.env.SUPABASE_KEY, "Prefer": method === "POST" ? "return=minimal" : "return=representation" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { var err = await res.text(); console.error("Supabase error:", res.status, err.substring(0, 200)); return null; }
    if (method === "POST" && res.status === 201) return true;
    var text = await res.text();
    return text ? JSON.parse(text) : true;
  } catch (e) { console.error("Supabase failed:", e.message); return null; }
}

async function getUserPlan(userId) {
  if (!userId) return "guest";
  try {
    var r = await supabaseQuery("GET", "usage_limits", null, "identifier=eq." + encodeURIComponent(userId) + "&select=plan");
    return (r && r[0] && r[0].plan) || "free";
  } catch (e) { return "free"; }
}

async function trackSearch(userId, sessionId, plan, query, componentType, resultsCount, source) {
  try {
    var today = new Date().toISOString().split("T")[0];
    if (sessionId) {
      var ex = await supabaseQuery("GET", "user_sessions", null, "session_id=eq." + encodeURIComponent(sessionId) + "&select=id,searches_count");
      if (ex && ex.length > 0) await supabaseQuery("PATCH", "user_sessions", { searches_count: (ex[0].searches_count || 0) + 1, last_active: new Date().toISOString(), plan: plan || "guest" }, "id=eq." + ex[0].id);
      else await supabaseQuery("POST", "user_sessions", { user_id: userId || null, session_id: sessionId, plan: plan || "guest", searches_count: 1, last_active: new Date().toISOString() });
    }
    var analytics = await supabaseQuery("GET", "daily_analytics", null, "date=eq." + today + "&select=id,total_searches,guest_searches,free_searches,pro_searches,top_queries");
    var planField = (plan === "pro" || plan === "paid" || plan === "team" || plan === "enterprise") ? "pro_searches" : plan === "free" ? "free_searches" : "guest_searches";
    if (analytics && analytics.length > 0) {
      var rec = analytics[0];
      var tq = rec.top_queries || {};
      tq[query] = (tq[query] || 0) + 1;
      var upd = { total_searches: (rec.total_searches || 0) + 1, top_queries: tq };
      upd[planField] = (rec[planField] || 0) + 1;
      await supabaseQuery("PATCH", "daily_analytics", upd, "id=eq." + rec.id);
    } else {
      var nr = { date: today, total_searches: 1, total_users: 1, guest_searches: 0, free_searches: 0, pro_searches: 0, top_queries: {} };
      nr[planField] = 1; nr.top_queries[query] = 1;
      await supabaseQuery("POST", "daily_analytics", nr);
    }
  } catch (e) { console.error("trackSearch failed:", e.message); }
}

async function trackInteraction(data) {
  try {
    await supabaseQuery("POST", "interactions", { session_id: data.sessionId || "anon", query: data.query || "", component_type: data.componentType || "", required_voltage: data.requiredVoltage || null, required_current: data.requiredCurrent || null, part_number: data.partNumber || "", manufacturer: data.manufacturer || "", action: data.action || "", position: data.position || null, total_results: data.totalResults || null });
    var score = 0;
    if (data.action === "buy_dk" || data.action === "buy_mouser" || data.action === "buy") score = 10;
    else if (data.action === "datasheet") score = 5;
    else if (data.action === "card_click") score = 2;
    else if (data.action === "negative_feedback") score = -8;
    if (data.position && score > 0) score += (data.position - 1) * 2;
    var qn = (data.query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var ex = await supabaseQuery("GET", "part_performance", null, "query_normalized=eq." + encodeURIComponent(qn) + "&part_number=eq." + encodeURIComponent(data.partNumber || "") + "&select=id,buy_clicks,datasheet_clicks,card_clicks,total_score");
    if (ex && ex.length > 0) {
      var upd2 = { total_score: (ex[0].total_score || 0) + score, last_updated: new Date().toISOString() };
      if (data.action === "buy_dk" || data.action === "buy_mouser" || data.action === "buy") upd2.buy_clicks = (ex[0].buy_clicks || 0) + 1;
      else if (data.action === "datasheet") upd2.datasheet_clicks = (ex[0].datasheet_clicks || 0) + 1;
      else if (data.action === "card_click") upd2.card_clicks = (ex[0].card_clicks || 0) + 1;
      await supabaseQuery("PATCH", "part_performance", upd2, "id=eq." + ex[0].id);
    } else {
      await supabaseQuery("POST", "part_performance", { query_normalized: qn, component_type: data.componentType || "", required_voltage: data.requiredVoltage || null, required_current: data.requiredCurrent || null, part_number: data.partNumber || "", manufacturer: data.manufacturer || "", buy_clicks: (data.action === "buy_dk" || data.action === "buy_mouser" || data.action === "buy") ? 1 : 0, datasheet_clicks: data.action === "datasheet" ? 1 : 0, card_clicks: data.action === "card_click" ? 1 : 0, alternative_searches: 0, negative_feedback: 0, total_score: score, search_count: 0, last_updated: new Date().toISOString() });
    }
  } catch (e) { console.error("trackInteraction failed:", e.message); }
}

async function updatePartSearchCount(queryNorm, partNumber, position) {
  try {
    var ex = await supabaseQuery("GET", "part_performance", null, "query_normalized=eq." + encodeURIComponent(queryNorm) + "&part_number=eq." + encodeURIComponent(partNumber) + "&select=id,search_count,avg_position");
    if (ex && ex.length > 0) {
      var sc = (ex[0].search_count || 0) + 1;
      var ap = ((ex[0].avg_position || position) * (sc - 1) + position) / sc;
      await supabaseQuery("PATCH", "part_performance", { search_count: sc, avg_position: Math.round(ap * 10) / 10, last_search: new Date().toISOString() }, "id=eq." + ex[0].id);
    } else {
      await supabaseQuery("POST", "part_performance", { query_normalized: queryNorm, part_number: partNumber, search_count: 1, avg_position: position, total_score: 0, buy_clicks: 0, datasheet_clicks: 0, card_clicks: 0, alternative_searches: 0, negative_feedback: 0, last_search: new Date().toISOString(), last_updated: new Date().toISOString() });
    }
  } catch (e) {}
}

async function getLearnedRankings(query, componentType) {
  try {
    var qn = (query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var r = await supabaseQuery("GET", "part_performance", null, "query_normalized=eq." + encodeURIComponent(qn) + "&total_score=gt.0&order=total_score.desc&limit=10&select=part_number,total_score");
    if (!r || r.length === 0) {
      if (componentType) r = await supabaseQuery("GET", "part_performance", null, "component_type=eq." + encodeURIComponent(componentType) + "&total_score=gt.5&order=total_score.desc&limit=10&select=part_number,total_score");
    }
    return r || [];
  } catch (e) { return []; }
}

function applyLearnedRanking(parts, learnedData) {
  if (!learnedData || learnedData.length === 0) return parts;
  var scoreMap = {};
  learnedData.forEach(function(r) { scoreMap[r.part_number] = r.total_score; });
  return parts.slice().sort(function(a, b) { return (scoreMap[b.partNumber] || 0) - (scoreMap[a.partNumber] || 0); });
}

// =============================================
// NEXAR / OCTOPART API
// =============================================
var nexarToken = null;
var nexarTokenExpiry = null;
var nexarTokenPromise = null;

async function getNexarToken() {
  if (nexarToken && nexarTokenExpiry && Date.now() < nexarTokenExpiry) return nexarToken;
  if (nexarTokenPromise) return nexarTokenPromise;
  nexarTokenPromise = (async function() {
    try {
      var fetch = (await import("node-fetch")).default;
      var res = await fetch("https://identity.nexar.com/connect/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.NEXAR_CLIENT_ID, client_secret: process.env.NEXAR_CLIENT_SECRET }),
      });
      var data = await res.json();
      if (data.access_token) {
        nexarToken = data.access_token;
        nexarTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
        console.log("Nexar token refreshed");
        nexarTokenPromise = null;
        return nexarToken;
      }
      nexarTokenPromise = null;
      return null;
    } catch (e) { console.error("Nexar token failed:", e.message); nexarTokenPromise = null; return null; }
  })();
  return nexarTokenPromise;
}

async function searchNexar(query, limit) {
  try {
    var cacheKey = "nexar_" + query.toLowerCase().trim().substring(0, 60);
    var cached = getCached(partCache, cacheKey);
    if (cached) { console.log("Nexar cache hit"); return cached; }

    var fetch = (await import("node-fetch")).default;
    var token = await getNexarToken();
    if (!token) { console.error("No Nexar token"); return null; }

    var graphqlQuery = JSON.stringify({
      query: "query SearchParts($q: String!, $limit: Int!) { supSearch(q: $q, limit: $limit, inStockOnly: false) { hits { part { mpn manufacturer { name } shortDescription specs { attribute { name shortname } displayValue } sellers(includeBrokers: false) { company { name } offers { inventoryLevel prices { quantity price currency } } } bestOffer { inventoryLevel prices { quantity price currency } } datasheets { url } category { name } } } } }",
      variables: { q: query, limit: limit || 20 }
    });

    var res = await fetch("https://api.nexar.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: graphqlQuery,
    });

    if (!res.ok) { console.error("Nexar search error:", res.status); return null; }
    var data = await res.json();
    if (data.errors) { console.error("Nexar GraphQL errors:", JSON.stringify(data.errors).substring(0, 200)); return null; }
    var hits = (data.data && data.data.supSearch && data.data.supSearch.hits) || [];
    console.log("Nexar returned", hits.length, "results for:", query);
    setCache(partCache, cacheKey, hits, PART_TTL);
    return hits;
  } catch (e) { console.error("Nexar search failed:", e.message); return null; }
}

function formatNexarPart(hit) {
  var part = hit.part || {};
  var sellers = part.sellers || [];
  var specs = part.specs || [];

  // Build stock map across all distributors
  var stockMap = {};
  var priceMap = {};
  sellers.forEach(function(seller) {
    var name = (seller.company && seller.company.name) || "";
    var offers = seller.offers || [];
    offers.forEach(function(offer) {
      var inv = offer.inventoryLevel || 0;
      var prices = offer.prices || [];
      if (inv > 0) stockMap[name] = (stockMap[name] || 0) + inv;
      if (prices.length > 0) {
        var p1 = prices[0];
        if (p1.price && !priceMap[name]) priceMap[name] = "$" + parseFloat(p1.price).toFixed(3);
      }
    });
  });

  var totalStock = Object.values(stockMap).reduce(function(a, b) { return a + b; }, 0);
  var dkStock = stockMap["Digi-Key"] || stockMap["DigiKey"] || 0;
  var mousStock = stockMap["Mouser"] || 0;
  var arrowStock = stockMap["Arrow"] || 0;
  var lcscStock = stockMap["LCSC"] || 0;

  var bestPrice = null;
  var bestPriceSource = null;
  Object.keys(priceMap).forEach(function(name) {
    var v = parseFloat((priceMap[name] || "999").replace(/[^0-9.]/g, "")) || 999;
    var cv = parseFloat((bestPrice || "999").replace(/[^0-9.]/g, "")) || 999;
    if (v < cv) { bestPrice = priceMap[name]; bestPriceSource = name; }
  });

  // Get price breaks from best seller
  var priceBreaks = [];
  sellers.forEach(function(seller) {
    (seller.offers || []).forEach(function(offer) {
      if ((offer.inventoryLevel || 0) > 0 && offer.prices && offer.prices.length > 1) {
        priceBreaks = offer.prices.slice(0, 5).map(function(p) {
          return { qty: p.quantity, price: "$" + parseFloat(p.price).toFixed(3) };
        });
      }
    });
  });

  var datasheetUrl = (part.datasheets && part.datasheets[0] && part.datasheets[0].url) || null;

  // Build buy URLs
  var dkUrl = "https://www.digikey.com/en/products/result?keywords=" + encodeURIComponent(part.mpn || "");
  var mousUrl = "https://www.mouser.com/Search/Refine?Keyword=" + encodeURIComponent(part.mpn || "");

  return {
    mpn: part.mpn || "",
    manufacturer: (part.manufacturer && part.manufacturer.name) || "",
    description: part.shortDescription || "",
    category: (part.category && part.category.name) || "",
    specs: specs,
    totalStock: totalStock,
    dkStock: dkStock,
    mousStock: mousStock,
    arrowStock: arrowStock,
    lcscStock: lcscStock,
    stockMap: stockMap,
    bestPrice: bestPrice,
    bestPriceSource: bestPriceSource,
    priceBreaks: priceBreaks,
    datasheetUrl: datasheetUrl,
    dkUrl: dkUrl,
    mousUrl: mousUrl,
  };
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
      var res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: model, max_tokens: maxTokens || 3000, system: system, messages: messages }),
      });
      var data = await res.json();
      if (data.error && data.error.type === "overloaded_error") { await new Promise(function(r) { setTimeout(r, attempt * 3000); }); continue; }
      if (data.error) return { error: data.error.message };
      return { text: (data.content || []).map(function(b) { return b.text || ""; }).join("") };
    } catch (e) { if (attempt < 3) await new Promise(function(r) { setTimeout(r, 2000); }); }
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

function extractRequiredSpecs(query) {
  var lower = query.toLowerCase(); var specs = {};
  var vM = lower.match(/(\d+(?:\.\d+)?)\s*v(?:dc|ac)?\b/gi) || [];
  if (vM.length > 0) { var vs = vM.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; }); if (vs.length > 0) specs.voltage = Math.max.apply(null, vs); }
  var aM = lower.match(/(\d+(?:\.\d+)?)\s*a\b/gi) || [];
  if (aM.length > 0) { var as2 = aM.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; }); if (as2.length > 0) specs.current = Math.max.apply(null, as2); }
  var ufM = lower.match(/(\d+(?:\.\d+)?)\s*uf\b/gi) || [];
  if (ufM.length > 0) specs.capacitanceUF = parseFloat(ufM[0]);
  var uhM = lower.match(/(\d+(?:\.\d+)?)\s*uh\b/gi) || [];
  if (uhM.length > 0) specs.inductanceUH = parseFloat(uhM[0]);
  var pinM = lower.match(/(\d+)\s*(?:pin|p)\b/gi) || [];
  if (pinM.length > 0) specs.pins = parseInt(pinM[0]);
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
  if (q.includes("microcontroller") || q.includes("mcu")) return "mcu";
  if (q.includes("crystal") || q.includes("oscillator")) return "crystal";
  return null;
}

var COMPONENT_KEYWORDS = ["relay","mosfet","capacitor","resistor","inductor","diode","transistor","op-amp","opamp","ldo","regulator","sensor","connector","switch","fuse","crystal","oscillator","driver","controller","igbt","thyristor","triac","optocoupler","transformer","ic","chip","bjt","scr","module","rectifier","varistor","thermistor","potentiometer","encoder","solenoid","motor driver","gate driver","voltage reference","comparator","adc","dac","mux","buffer","schottky","zener","fet","microcontroller","mcu","fpga","memory","eeprom","flash","arduino","esp32","stm32"];

function isComponentQuery(message) {
  var lower = message.toLowerCase();
  for (var i = 0; i < COMPONENT_KEYWORDS.length; i++) { if (lower.includes(COMPONENT_KEYWORDS[i])) return true; }
  return false;
}

// =============================================
// SYSTEM PROMPTS
// =============================================
var INTENT_SYSTEM = "You classify hardware engineering queries. RULES:\n1. ANY message mentioning a component name MUST be 'part_search': relay, MOSFET, capacitor, resistor, inductor, diode, transistor, op-amp, LDO, regulator, sensor, connector, IC, BJT, IGBT, FET, schottky, zener, microcontroller, MCU, crystal, oscillator.\n2. 'circuit_question' only if asking HOW something works with NO component request.\n3. 'calculation' only if asking to calculate a value.\n4. 'general' only if completely unrelated to electronics.\n5. Follow-up refinements keep SAME intent.\nRespond ONLY with JSON: {\"intent\":\"part_search|find_alternatives|generate_bom|circuit_question|calculation|correction|general\",\"partNumber\":null,\"nexarQuery\":\"optimized search query for Nexar/Octopart\"}";

var ENGINEERING_SYSTEM = "You are PartTensor, a senior hardware application engineer AI. Help engineers with component selection, circuit design, calculations, and troubleshooting. Be direct, technical and precise. Format with **bold headers** and bullet points.";

var RANK_SYSTEM = "You are a senior hardware application engineer. Given real electronic parts from Nexar/Octopart with real specs and stock data, pick the best 4 parts for the user request and format them.\n\nRULES:\n1. Pick parts that BEST match the required specs\n2. Prefer parts with more stock\n3. Prefer established manufacturers\n4. rank: first=top, second=good, third=alternative, fourth=alternative\n5. aeComment: explain specifically why this part fits with real spec values\n6. Extract keySpecs from the spec data provided\n7. caution: note any important limitations\n\nRespond ONLY with raw JSON:\n{\"category\":\"Type\",\"interpretation\":\"one sentence summary\",\"designTip\":\"one practical tip\",\"results\":[{\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"type\":\"Type\",\"keySpecs\":[{\"label\":\"L\",\"value\":\"V\",\"unit\":\"U\"},{\"label\":\"L2\",\"value\":\"V2\",\"unit\":\"U2\"},{\"label\":\"L3\",\"value\":\"V3\",\"unit\":\"U3\"},{\"label\":\"Package\",\"value\":\"PKG\",\"unit\":\"\"}],\"package\":\"PKG\",\"rank\":\"top\",\"aeComment\":\"Specific reason with real spec values\",\"caution\":null,\"applications\":[\"app1\",\"app2\"]}]}";

var ALT_SEARCH_SYSTEM = "Find EXACTLY 4 drop-in alternatives. Meet/exceed original specs. Different manufacturers. 4 keySpecs each.\nRespond ONLY with raw JSON:\n{\"originalPart\":\"MPN\",\"originalSpecs\":\"specs\",\"alternatives\":[{\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"type\":\"Type\",\"compatibility\":\"drop-in\",\"keySpecs\":[{\"label\":\"L\",\"value\":\"V\",\"unit\":\"U\"}],\"package\":\"PKG\",\"whyAlternative\":\"reason\",\"differences\":\"diffs\"}],\"importantNote\":\"note\"}";

var BOM_SYSTEM = "Generate a complete BOM. Include ALL critical components. Use exact MPNs from major manufacturers.\nRespond ONLY with raw JSON:\n{\"projectName\":\"name\",\"description\":\"sentence\",\"voltage\":\"V\",\"power\":\"W\",\"designNotes\":\"notes\",\"totalEstimate\":\"$X-Y\",\"bomItems\":[{\"id\":1,\"function\":\"fn\",\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"description\":\"desc\",\"category\":\"IC\",\"quantity\":1,\"keySpecs\":\"specs\",\"package\":\"PKG\",\"priority\":\"critical\",\"unitPrice\":\"$X\",\"notes\":null}]}";

// =============================================
// HEALTH
// =============================================
app.get("/api/health", function(req, res) {
  res.json({ status: "ok", service: "PartTensor", nexar: !!process.env.NEXAR_CLIENT_ID, time: new Date().toISOString() });
});

// =============================================
// ANALYTICS
// =============================================
app.get("/api/analytics", async function(req, res) {
  try {
    var days = parseInt(req.query.days) || 7;
    var analytics = await supabaseQuery("GET", "daily_analytics", null, "order=date.desc&limit=" + days + "&select=*");
    var topParts = await supabaseQuery("GET", "part_performance", null, "total_score=gt.0&order=total_score.desc&limit=10&select=part_number,manufacturer,component_type,buy_clicks,total_score,search_count");
    res.json({ analytics: analytics || [], topParts: topParts || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// TRACK
// =============================================
app.post("/api/track", async function(req, res) {
  try { await trackInteraction(req.body); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false }); }
});

// =============================================
// FEEDBACK
// =============================================
app.post("/api/feedback", async function(req, res) {
  try {
    var partNumber = req.body.partNumber; var feedback = req.body.feedback;
    if (!partNumber || !feedback) return res.status(400).json({ error: "Required" });
    var score = feedback === "good" ? 5 : -10;
    var qn = (req.body.query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var ex = await supabaseQuery("GET", "part_performance", null, "query_normalized=eq." + encodeURIComponent(qn) + "&part_number=eq." + encodeURIComponent(partNumber) + "&select=id,total_score,negative_feedback");
    if (ex && ex.length > 0) {
      var upd = { total_score: (ex[0].total_score || 0) + score, last_updated: new Date().toISOString() };
      if (feedback === "bad") upd.negative_feedback = (ex[0].negative_feedback || 0) + 1;
      await supabaseQuery("PATCH", "part_performance", upd, "id=eq." + ex[0].id);
    } else {
      await supabaseQuery("POST", "part_performance", { query_normalized: qn, component_type: req.body.componentType || "", part_number: partNumber, manufacturer: req.body.manufacturer || "", total_score: score, negative_feedback: feedback === "bad" ? 1 : 0, buy_clicks: 0, datasheet_clicks: 0, card_clicks: 0, alternative_searches: 0, search_count: 0, last_updated: new Date().toISOString() });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// STOCK BULK (for BOM background load)
// =============================================
app.post("/api/stock-bulk", async function(req, res) {
  try {
    var partNumbers = req.body.partNumbers || [];
    if (partNumbers.length === 0) return res.json({});
    var results = await Promise.all(partNumbers.map(async function(pn) {
      var hits = await searchNexar(pn, 3);
      if (!hits || hits.length === 0) return null;
      var formatted = formatNexarPart(hits[0]);
      return { found: formatted.totalStock > 0, totalStock: formatted.totalStock, bestPrice: formatted.bestPrice, bestPriceSource: formatted.bestPriceSource, digikey: { stock: formatted.dkStock, url: formatted.dkUrl }, mouser: { stock: formatted.mousStock, url: formatted.mousUrl }, octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(pn) };
    }));
    var stockMap = {};
    partNumbers.forEach(function(pn, i) { stockMap[pn] = results[i]; });
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
    var pnIdx = 0;
    ["part number","pn","mpn","part no","partno","part#","component","part_number"].forEach(function(kw) { headers.forEach(function(h, i) { if (h.includes(kw)) pnIdx = i; }); });
    var descIdx = -1;
    ["description","desc","value","specification"].forEach(function(kw) { headers.forEach(function(h, i) { if (h.includes(kw) && i !== pnIdx) descIdx = i; }); });
    var qtyIdx = -1;
    ["qty","quantity","count","pcs"].forEach(function(kw) { headers.forEach(function(h, i) { if (h.includes(kw)) qtyIdx = i; }); });
    var bomRows = [];
    for (var li = 1; li < lines.length; li++) {
      var cols = lines[li].split(",").map(function(c) { return c.replace(/"/g, "").trim(); });
      if (cols[pnIdx]) bomRows.push({ partNumber: cols[pnIdx], description: descIdx >= 0 ? cols[descIdx] || "" : "", quantity: qtyIdx >= 0 ? parseInt(cols[qtyIdx]) || 1 : 1 });
    }
    if (bomRows.length === 0) return res.status(400).json({ error: "No part numbers found" });
    var results = [];
    for (var pi = 0; pi < Math.min(bomRows.length, 30); pi++) {
      var row = bomRows[pi];
      var hits = await searchNexar(row.partNumber, 3);
      var formatted = hits && hits.length > 0 ? formatNexarPart(hits[0]) : null;
      var result = { partNumber: row.partNumber, description: row.description, quantity: row.quantity, stock: formatted ? formatted.totalStock : 0, bestPrice: formatted ? (formatted.bestPrice || "") : "", dkStock: formatted ? formatted.dkStock : 0, mousStock: formatted ? formatted.mousStock : 0, arrowStock: formatted ? formatted.arrowStock : 0, alt1: "", alt2: "", alt3: "" };
      try {
        var altRes = await callClaude(ALT_SEARCH_SYSTEM, [{ role: "user", content: "Find alternatives for " + row.partNumber + (row.description ? " (" + row.description + ")" : "") }], 2000);
        var altParsed = altRes.text ? extractJSON(altRes.text) : null;
        if (altParsed && altParsed.alternatives) {
          var alts = altParsed.alternatives.slice(0, 3);
          if (alts[0]) result.alt1 = alts[0].partNumber + " (" + alts[0].manufacturer + ")";
          if (alts[1]) result.alt2 = alts[1].partNumber + " (" + alts[1].manufacturer + ")";
          if (alts[2]) result.alt3 = alts[2].partNumber + " (" + alts[2].manufacturer + ")";
        }
      } catch (e) {}
      results.push(result);
    }
    var csvHeaders = ["Part Number","Description","Quantity","Total Stock","Best Price","Digi-Key Stock","Mouser Stock","Arrow Stock","Alternative 1","Alternative 2","Alternative 3"];
    var csv = [csvHeaders].concat(results.map(function(r) { return [r.partNumber,r.description,r.quantity,r.stock,r.bestPrice,r.dkStock,r.mousStock,r.arrowStock,r.alt1,r.alt2,r.alt3]; })).map(function(row) { return row.map(function(c) { return '"' + String(c||"").replace(/"/g,'""') + '"'; }).join(","); }).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=BOM_PartTensor.csv");
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    var order = await rzp.orders.create({ amount: amount, currency: "INR", receipt: "pt_" + Date.now(), notes: { userId: req.body.userId || "", planKey: planKey } });
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
    res.json({ success: true, plan: planName, planKey: planKey });
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

    var requiredSpecs = extractRequiredSpecs(message);
    var componentType = detectComponentType(message);
    var searchCacheKey = "search_" + message.toLowerCase().trim().substring(0, 80);
    var cachedResult = getCached(aiCache, searchCacheKey);

    // Build intent input
    var contextSummary = history.slice(-6).map(function(m) { return (m.role === "user" ? "User: " : "AI: ") + (m.content || "").substring(0, 150); }).join("\n");
    var intentInput = history.length > 0 ? "Previous:\n" + contextSummary + "\n\nNew message: " + message : message;

    // Launch in parallel: intent + plan lookup + nexar search (if not cached)
    var intentPromise = callClaude(INTENT_SYSTEM, [{ role: "user", content: intentInput }], 400);
    var planPromise = userId ? getUserPlan(userId) : Promise.resolve(clientPlan);
    var nexarPromise = (!cachedResult && isComponentQuery(message))
      ? searchNexar(message, 20)
      : Promise.resolve(null);

    // Resolve plan for usage check
    var plan = await planPromise;
    var planLimits = PLANS[plan] || PLANS.guest;
    console.log("Plan:", plan, "BOM:", planLimits.bom);

    // Usage limits
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
            if (count > planLimits.messages) return res.json({ error: "Daily limit reached", limitReached: true, plan: plan });
            await supabaseQuery("PATCH", "usage_limits", { message_count: count }, "id=eq." + usage.id);
          }
        } else {
          await supabaseQuery("POST", "usage_limits", { identifier: identifier, identifier_type: userId ? "user" : "ip", message_count: 1, last_reset: today, plan: plan });
        }
      } catch (e) { console.error("Usage check failed:", e.message); }
    }

    // Resolve intent
    var intentResult = await intentPromise;
    var intent = "part_search"; var detectedPN = null; var nexarQuery = message;
    if (intentResult.text) {
      var ip = extractJSON(intentResult.text);
      if (ip) {
        intent = ip.intent || "part_search";
        detectedPN = ip.partNumber || null;
        nexarQuery = ip.nexarQuery || message;
      }
    }
    if (isComponentQuery(message) && intent === "general") intent = "part_search";
    console.log("Intent:", intent, "Component:", componentType, "Specs:", JSON.stringify(requiredSpecs));

    if (intent === "general") {
      return res.json({ text: "I am PartTensor, a hardware engineering AI. I can help you find electronic components, check live stock across DigiKey, Mouser and Arrow, generate BOMs, and answer circuit design questions.", intent: intent, mode: "text" });
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

    // FIND ALTERNATIVES - use Nexar
    if (intent === "find_alternatives") {
      var pn = detectedPN || message.match(/\b([A-Z]{1,6}[0-9]{2,}[A-Z0-9\-]*)\b/i)?.[0];
      if (!pn) return res.json({ text: "Could you specify the part number you want alternatives for?", intent: intent, mode: "question" });
      var altHits = await searchNexar(pn + " alternative equivalent", 15);
      if (altHits && altHits.length > 0) {
        var altFormatted = altHits.slice(0, 8).map(formatNexarPart);
        var altContext = altFormatted.map(function(p) { return p.mpn + " (" + p.manufacturer + ") " + p.description + " stock:" + p.totalStock; }).join("\n");
        var altRankResult = await callClaude(ALT_SEARCH_SYSTEM, [{ role: "user", content: "Original part: " + pn + "\nFind alternatives from these real parts:\n" + altContext }], 2500);
        var altData = altRankResult.text ? extractJSON(altRankResult.text) : null;
        if (altData && altData.alternatives) {
          var altStockMap = {};
          altData.alternatives.forEach(function(p) {
            var found = altFormatted.find(function(f) { return f.mpn === p.partNumber; });
            if (found) altStockMap[p.partNumber] = { found: found.totalStock > 0, totalStock: found.totalStock, bestPrice: found.bestPrice, bestPriceSource: found.bestPriceSource, digikey: { stock: found.dkStock, url: found.dkUrl }, mouser: { stock: found.mousStock, url: found.mousUrl }, octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(p.partNumber) };
          });
          return res.json({ text: "Here are **" + altData.alternatives.length + " alternatives** for **" + pn + "** with live stock from Nexar:", mode: "alt", originalPart: altData.originalPart || pn, originalSpecs: altData.originalSpecs || "", alternatives: altData.alternatives, stockData: altStockMap, importantNote: altData.importantNote || null, intent: intent, query: message, componentType: componentType });
        }
      }
      return res.json({ text: "Could not find alternatives for " + pn + ". Please try again.", intent: intent, mode: "text" });
    }

    // BOM - Pro+ only
    if (intent === "generate_bom") {
      if (!planLimits.bom) return res.json({ text: "BOM generation is available on Pro and above.", intent: intent, mode: "upgrade", feature: "bom", requiredPlan: "pro" });
      var bomCacheKey = "bom_" + message.toLowerCase().trim().substring(0, 80);
      var bomCached = getCached(aiCache, bomCacheKey);
      if (bomCached) return res.json(bomCached);
      var bomResult = await callClaude(BOM_SYSTEM, fullMessages, 4000);
      var bomData = bomResult.text ? extractJSON(bomResult.text) : null;
      if (!bomData || !bomData.bomItems) return res.json({ text: "Could you describe the application in more detail?", intent: intent, mode: "question" });
      bomData.stockData = {};
      var bomResponse = Object.assign({ text: "Here is a complete BOM for **" + bomData.projectName + "** -- " + bomData.bomItems.length + " critical components. Stock loading...", intent: intent }, bomData);
      setCache(aiCache, bomCacheKey, bomResponse, AI_TTL);
      return res.json(bomResponse);
    }

    // ==========================================
    // PART SEARCH - Nexar + Claude ranking
    // ==========================================
    var parts = null; var searchMeta = {}; var source = "cache";

    if (cachedResult) {
      console.log("Cache hit - instant");
      parts = cachedResult.results || [];
      searchMeta = { category: cachedResult.category, interpretation: cachedResult.interpretation, designTip: cachedResult.designTip };
    } else {
      // Use already-started Nexar promise
      var nexarHits = await nexarPromise;

      // If nexarQuery from intent is better, try again with optimized query
      if ((!nexarHits || nexarHits.length < 3) && nexarQuery !== message) {
        console.log("Retrying with optimized query:", nexarQuery);
        nexarHits = await searchNexar(nexarQuery, 20);
      }

      if (!nexarHits || nexarHits.length === 0) {
        return res.json({ text: "No parts found for your query. Please try with more specific terms.", intent: intent, mode: "text" });
      }

      console.log("Nexar returned", nexarHits.length, "candidates - asking Claude to rank...");

      // Format all Nexar results for Claude
      var formattedHits = nexarHits.map(formatNexarPart);

      // Build context for Claude with real data
      var partsContext = formattedHits.map(function(p, i) {
        var specStr = p.specs.slice(0, 8).map(function(s) { return (s.attribute && s.attribute.shortname || s.attribute && s.attribute.name || "") + "=" + s.displayValue; }).join(", ");
        var stockStr = Object.keys(p.stockMap).map(function(k) { return k + ":" + p.stockMap[k]; }).join(", ");
        return (i+1) + ". MPN:" + p.mpn + " Mfr:" + p.manufacturer + " Cat:" + p.category + " Stock:[" + stockStr + "] BestPrice:" + (p.bestPrice || "N/A") + " Specs:[" + specStr + "] Desc:" + p.description.substring(0, 100);
      }).join("\n");

      var rankPrompt = "User request: " + message + "\nRequired specs: " + JSON.stringify(requiredSpecs) + "\n\nHere are " + formattedHits.length + " real parts from Nexar/Octopart with verified stock data:\n\n" + partsContext + "\n\nPick the best 4 parts that match the user request. Use the EXACT MPN and manufacturer from the data above.";

      var rankResult = await callClaude(RANK_SYSTEM, [{ role: "user", content: rankPrompt }], 3000);
      var rankData = rankResult.text ? extractJSON(rankResult.text) : null;

      if (!rankData || !rankData.results || rankData.results.length === 0) {
        return res.json({ text: "Could not rank parts. Please try again.", intent: intent, mode: "text" });
      }

      parts = rankData.results;
      searchMeta = { category: rankData.category || componentType || "", interpretation: rankData.interpretation || "", designTip: rankData.designTip || "" };
      source = "nexar";

      // Build stock data from Nexar results
      var nexarStockMap = {};
      parts.forEach(function(p) {
        var found = formattedHits.find(function(f) { return f.mpn === p.partNumber || f.mpn.toUpperCase() === p.partNumber.toUpperCase(); });
        if (found) {
          nexarStockMap[p.partNumber] = {
            found: found.totalStock > 0,
            totalStock: found.totalStock,
            bestPrice: found.bestPrice,
            bestPriceSource: found.bestPriceSource,
            priceBreaks: found.priceBreaks,
            digikey: { found: found.dkStock > 0, stock: found.dkStock, url: found.dkUrl },
            mouser:  { found: found.mousStock > 0, stock: found.mousStock, url: found.mousUrl },
            arrow:   { found: found.arrowStock > 0, stock: found.arrowStock },
            lcsc:    { found: found.lcscStock > 0, stock: found.lcscStock },
            octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(p.partNumber),
            datasheetUrl: found.datasheetUrl,
          };
          // Add datasheet to part card
          if (found.datasheetUrl) p.datasheetUrl = found.datasheetUrl;
        }
      });

      setCache(aiCache, searchCacheKey, Object.assign({ results: parts, stockData: nexarStockMap }, searchMeta), AI_TTL);

      // Apply learned ranking
      var learnedData = await getLearnedRankings(message, componentType);
      if (learnedData.length > 0) {
        console.log("Applying learned ranking");
        parts = applyLearnedRanking(parts, learnedData);
      }

      // Sort by stock
      parts = parts.slice().sort(function(a, b) {
        var aS = nexarStockMap[a.partNumber] ? nexarStockMap[a.partNumber].totalStock : 0;
        var bS = nexarStockMap[b.partNumber] ? nexarStockMap[b.partNumber].totalStock : 0;
        return (bS > 0 ? 1 : 0) - (aS > 0 ? 1 : 0) || bS - aS;
      });

      // Track search behaviour
      var qn = message.toLowerCase().trim().replace(/\s+/g, " ");
      trackSearch(userId, sessionId, plan, message, componentType, parts.length, source).catch(function() {});
      parts.forEach(function(p, i) { updatePartSearchCount(qn, p.partNumber, i + 1).catch(function() {}); });

      console.log("Returning", parts.length, "parts from Nexar, source:", source);

      return res.json({
        text: "Found **" + parts.length + " parts** with live stock from DigiKey, Mouser, Arrow and more:",
        mode: "search",
        category: searchMeta.category || componentType || "",
        interpretation: searchMeta.interpretation || "",
        designTip: searchMeta.designTip || "",
        results: parts,
        stockData: nexarStockMap,
        intent: intent,
        query: message,
        componentType: componentType,
        requiredVoltage: requiredSpecs.voltage || null,
        requiredCurrent: requiredSpecs.current || null,
        source: source,
      });
    }

    // Cached result path
    var learnedData2 = await getLearnedRankings(message, componentType);
    if (learnedData2.length > 0) parts = applyLearnedRanking(parts, learnedData2);
    var cachedStock = cachedResult.stockData || {};

    return res.json({
      text: "Found **" + parts.length + " parts** with live stock from DigiKey, Mouser, Arrow and more:",
      mode: "search",
      category: searchMeta.category || componentType || "",
      interpretation: searchMeta.interpretation || "",
      designTip: searchMeta.designTip || "",
      results: parts,
      stockData: cachedStock,
      intent: intent,
      query: message,
      componentType: componentType,
      requiredVoltage: requiredSpecs.voltage || null,
      requiredCurrent: requiredSpecs.current || null,
      source: "cache",
    });

  } catch (err) {
    console.error("Chat error:", err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ error: "Server error: " + err.message });
  }
});

// Keep alive
setInterval(async function() {
  try { var fetch = (await import("node-fetch")).default; await fetch("https://parttensor-backend.onrender.com/api/health"); console.log("Keep-alive ping"); } catch (e) {}
}, 14 * 60 * 1000);

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log("\nPartTensor backend running on port " + PORT);
  console.log("Flow: Nexar/Octopart (real parts) -> Claude (rank + commentary) -> No Gemini");
  console.log("Stock: DigiKey + Mouser + Arrow + LCSC all from Nexar in one call\n");
});