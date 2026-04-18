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
  guest:      { messages: 5,   bom: false, excel: false, history: false, alternatives: 3,  api: false },
  free:       { messages: 20,  bom: false, excel: false, history: true,  alternatives: 5,  api: false },
  pro:        { messages: 9999,bom: true,  excel: true,  history: true,  alternatives: 999,api: false },
  team:       { messages: 9999,bom: true,  excel: true,  history: true,  alternatives: 999,api: false },
  enterprise: { messages: 9999,bom: true,  excel: true,  history: true,  alternatives: 999,api: true  },
};

var PRICES = {
  pro_monthly:  19900,  // Rs 199
  pro_yearly:   179900, // Rs 1799
  team_monthly: 99900,  // Rs 999
  team_yearly:  899900, // Rs 8999
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
    var result = await supabaseQuery("GET", "usage_limits", null, "identifier=eq." + encodeURIComponent(userId) + "&select=plan");
    if (result && result.length > 0) return result[0].plan || "free";
    return "free";
  } catch (e) { return "free"; }
}

async function trackInteraction(data) {
  try {
    await supabaseQuery("POST", "interactions", { session_id: data.sessionId || "anon", query: data.query || "", component_type: data.componentType || "", required_voltage: data.requiredVoltage || null, required_current: data.requiredCurrent || null, part_number: data.partNumber || "", manufacturer: data.manufacturer || "", action: data.action || "", position: data.position || null, total_results: data.totalResults || null });
    var score = 0;
    if (data.action === "buy_dk" || data.action === "buy_mouser") score = 10;
    else if (data.action === "datasheet") score = 5;
    else if (data.action === "card_click") score = 2;
    else if (data.action === "negative_feedback") score = -8;
    if (data.position && score > 0) score += (data.position - 1) * 2;
    var queryNorm = (data.query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var existing = await supabaseQuery("GET", "part_performance", null, "query_normalized=eq." + encodeURIComponent(queryNorm) + "&part_number=eq." + encodeURIComponent(data.partNumber || "") + "&select=id,buy_clicks,datasheet_clicks,card_clicks,total_score");
    if (existing && existing.length > 0) {
      var rec = existing[0];
      var updates = { total_score: (rec.total_score || 0) + score, last_updated: new Date().toISOString() };
      if (data.action === "buy_dk" || data.action === "buy_mouser") updates.buy_clicks = (rec.buy_clicks || 0) + 1;
      else if (data.action === "datasheet") updates.datasheet_clicks = (rec.datasheet_clicks || 0) + 1;
      else if (data.action === "card_click") updates.card_clicks = (rec.card_clicks || 0) + 1;
      await supabaseQuery("PATCH", "part_performance", updates, "id=eq." + rec.id);
    } else {
      await supabaseQuery("POST", "part_performance", { query_normalized: queryNorm, component_type: data.componentType || "", required_voltage: data.requiredVoltage || null, required_current: data.requiredCurrent || null, part_number: data.partNumber || "", manufacturer: data.manufacturer || "", buy_clicks: (data.action === "buy_dk" || data.action === "buy_mouser") ? 1 : 0, datasheet_clicks: data.action === "datasheet" ? 1 : 0, card_clicks: data.action === "card_click" ? 1 : 0, alternative_searches: 0, negative_feedback: 0, total_score: score, last_updated: new Date().toISOString() });
    }
  } catch (e) { console.error("trackInteraction failed:", e.message); }
}

async function getLearnedRankings(query, componentType) {
  try {
    var queryNorm = (query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var results = await supabaseQuery("GET", "part_performance", null, "query_normalized=eq." + encodeURIComponent(queryNorm) + "&total_score=gt.0&order=total_score.desc&limit=10&select=part_number,total_score");
    if (!results || results.length === 0) {
      if (componentType) results = await supabaseQuery("GET", "part_performance", null, "component_type=eq." + encodeURIComponent(componentType) + "&total_score=gt.5&order=total_score.desc&limit=10&select=part_number,total_score");
    }
    return results || [];
  } catch (e) { return []; }
}

function applyLearnedRanking(parts, learnedData) {
  if (!learnedData || learnedData.length === 0) return parts;
  var scoreMap = {};
  learnedData.forEach(function(r) { scoreMap[r.part_number] = r.total_score; });
  return parts.slice().sort(function(a, b) { return (scoreMap[b.partNumber] || 0) - (scoreMap[a.partNumber] || 0); });
}

// =============================================
// DIGIKEY
// =============================================
var digikeyToken = null;
var digikeyTokenExpiry = null;

async function getDigikeyToken() {
  if (digikeyToken && digikeyTokenExpiry && Date.now() < digikeyTokenExpiry) return digikeyToken;
  var fetch = (await import("node-fetch")).default;
  try {
    var res = await fetch("https://api.digikey.com/v1/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.DIGIKEY_CLIENT_ID, client_secret: process.env.DIGIKEY_CLIENT_SECRET }),
    });
    var data = await res.json();
    if (data.access_token) { digikeyToken = data.access_token; digikeyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000; console.log("DigiKey token refreshed"); return digikeyToken; }
    return null;
  } catch (e) { console.error("DigiKey token failed:", e.message); return null; }
}

async function lookupDigikey(mpn) {
  try {
    var cached = getCached(stockCache, "dk_" + mpn);
    if (cached) return cached;
    var fetch = (await import("node-fetch")).default;
    var token = await getDigikeyToken();
    if (!token) return null;
    var res = await fetch("https://api.digikey.com/products/v4/search/" + encodeURIComponent(mpn) + "/productdetails", { method: "GET", headers: { "Authorization": "Bearer " + token, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD" } });
    if (!res.ok) {
      var res2 = await fetch("https://api.digikey.com/products/v4/search/keyword", { method: "POST", headers: { "Authorization": "Bearer " + token, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD", "Content-Type": "application/json" }, body: JSON.stringify({ Keywords: mpn, Limit: 3, Offset: 0 }) });
      if (!res2.ok) return null;
      var d2 = await res2.json();
      var prods = d2.Products || [];
      if (prods.length === 0) return null;
      var best2 = prods.reduce(function(a, b) { return (b.QuantityAvailable || 0) > (a.QuantityAvailable || 0) ? b : a; });
      var p2 = best2.UnitPrice || (best2.StandardPricing && best2.StandardPricing[0] && best2.StandardPricing[0].UnitPrice) || null;
      var r2 = { found: true, stock: best2.QuantityAvailable || 0, price: p2 ? "$" + parseFloat(p2).toFixed(3) : null, url: best2.ProductUrl || "", matchedMPN: best2.ManufacturerProductNumber || mpn, parameters: best2.Parameters || [] };
      setCache(stockCache, "dk_" + mpn, r2, STOCK_TTL);
      return r2;
    }
    var data = await res.json();
    var product = data.Product || data;
    var unitPrice = product.UnitPrice || (product.StandardPricing && product.StandardPricing[0] && product.StandardPricing[0].UnitPrice) || null;
    var result = { found: true, stock: product.QuantityAvailable || 0, price: unitPrice ? "$" + parseFloat(unitPrice).toFixed(3) : null, url: product.ProductUrl || "", matchedMPN: product.ManufacturerProductNumber || mpn, parameters: product.Parameters || [] };
    setCache(stockCache, "dk_" + mpn, result, STOCK_TTL);
    return result;
  } catch (e) { console.error("DK lookup failed:", mpn, e.message); return null; }
}

async function lookupMouser(mpn) {
  try {
    var cached = getCached(stockCache, "mo_" + mpn);
    if (cached) return cached;
    var fetch = (await import("node-fetch")).default;
    var res = await fetch("https://api.mouser.com/api/v1/search/partnumber?apiKey=" + process.env.MOUSER_API_KEY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: "Begins With" } }) });
    var data = res.ok ? await res.json() : null;
    var parts = (data && data.SearchResults && data.SearchResults.Parts) || [];
    if (parts.length === 0) return null;
    var best = parts.reduce(function(a, b) { return (parseInt((b.Availability || "0").replace(/[^0-9]/g, "")) || 0) > (parseInt((a.Availability || "0").replace(/[^0-9]/g, "")) || 0) ? b : a; });
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
// GEMINI - Real-time part search
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

    var prompt = "Search DigiKey and Mouser right now for: " + query + (specsHint ? " [Required:" + specsHint + "]" : "") + "\n\nFind EXACTLY 4 real parts currently in stock on DigiKey or Mouser. Rules:\n1. Use EXACT manufacturer part number (MPN) as on DigiKey\n2. Specs must meet requirements\n3. Only in-stock parts\n4. Reputable manufacturers only: Infineon, Vishay, ON Semi, TI, STMicro, Rohm, Renesas, Omron, TE Connectivity, Panasonic, Murata, Wurth, Kemet, Bourns, Nexperia, Microchip\n\nReturn ONLY valid JSON, no markdown:\n{\"category\":\"type\",\"interpretation\":\"summary\",\"designTip\":\"tip\",\"results\":[{\"partNumber\":\"EXACT_MPN\",\"manufacturer\":\"Mfr\",\"type\":\"Type\",\"keySpecs\":[{\"label\":\"L\",\"value\":\"V\",\"unit\":\"U\"},{\"label\":\"L2\",\"value\":\"V2\",\"unit\":\"U2\"},{\"label\":\"L3\",\"value\":\"V3\",\"unit\":\"U3\"},{\"label\":\"Package\",\"value\":\"PKG\",\"unit\":\"\"}],\"package\":\"PKG\",\"rank\":\"top\",\"aeComment\":\"Why good choice\",\"caution\":null,\"applications\":[\"app\"]}]}";

    var res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + process.env.GEMINI_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      }),
    });

    if (!res.ok) { var errText = await res.text(); console.error("Gemini error:", res.status, errText.substring(0, 300)); return null; }
    var data = await res.json();
    var candidates = data.candidates || [];
    if (candidates.length === 0) return null;
    var parts2 = candidates[0].content && candidates[0].content.parts || [];
    var text = parts2.map(function(p) { return p.text || ""; }).join("");
    console.log("Gemini response (first 400):", text.substring(0, 400));
    var clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    var depth = 0, start = -1, end = -1;
    for (var i = 0; i < clean.length; i++) {
      if (clean[i] === "{") { if (depth === 0) start = i; depth++; }
      else if (clean[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (start === -1 || end === -1) return null;
    try {
      var parsed = JSON.parse(clean.substring(start, end + 1));
      if (parsed && parsed.results && parsed.results.length > 0) {
        console.log("Gemini found:", parsed.results.map(function(p) { return p.partNumber; }).join(", "));
        return parsed;
      }
      return null;
    } catch (e) { console.error("Gemini JSON parse failed:", e.message); return null; }
  } catch (e) { console.error("Gemini failed:", e.message); return null; }
}

// =============================================
// VALIDATE WITH DIGIKEY
// =============================================
async function validateWithDigiKey(parts, requiredSpecs) {
  if (!parts || parts.length === 0) return parts;
  console.log("Validating", parts.length, "parts with DigiKey...");
  var validated = [];
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    var dkResult = await lookupDigikey(part.partNumber);
    if (!dkResult) { console.log("  NOT FOUND:", part.partNumber); continue; }
    if (dkResult.matchedMPN && dkResult.matchedMPN !== part.partNumber) { console.log("  MPN fix:", part.partNumber, "->", dkResult.matchedMPN); part.partNumber = dkResult.matchedMPN; }
    var params = dkResult.parameters || [];
    var realVoltage = null, realCurrent = null;
    for (var j = 0; j < params.length; j++) {
      var name = (params[j].Parameter || "").toLowerCase();
      var val = parseFloat(params[j].Value);
      if (isNaN(val)) continue;
      if (name === "vds" || name === "vce" || name === "vrrm" || (name.includes("voltage") && !name.includes("threshold") && !name.includes("gate") && !name.includes("input"))) { if (!realVoltage) realVoltage = val; }
      if (name === "id" || name === "ic" || name === "iout" || name === "if" || (name.includes("current") && (name.includes("continuous") || name.includes("rated") || name.includes("contact")))) { if (!realCurrent) realCurrent = val; }
    }
    var valid = true;
    if (requiredSpecs.voltage && realVoltage && realVoltage < requiredSpecs.voltage * 0.95) { console.log("  REJECTED voltage:", part.partNumber, realVoltage + "V"); valid = false; }
    if (requiredSpecs.current && realCurrent && realCurrent < requiredSpecs.current * 0.95) { console.log("  REJECTED current:", part.partNumber, realCurrent + "A"); valid = false; }
    if (!valid) continue;
    if (realVoltage && part.keySpecs) {
      for (var k = 0; k < part.keySpecs.length; k++) {
        var label = (part.keySpecs[k].label || "").toLowerCase();
        if (label === "vds" || label === "vce" || label === "vrrm") part.keySpecs[k].value = String(realVoltage);
        if ((label === "id" || label === "ic") && realCurrent) part.keySpecs[k].value = String(realCurrent);
      }
    }
    part._dkStock = dkResult.stock;
    part._validated = true;
    console.log("  OK:", part.partNumber, "stock:", dkResult.stock);
    validated.push(part);
  }
  console.log("Validated: " + validated.length + "/" + parts.length);
  return validated;
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

var CLAUDE_PART_SYSTEM = "You are a senior hardware application engineer. Suggest EXACTLY 4 real electronic parts.\nRULES: Only parts that EXIST on DigiKey. Meet or exceed voltage and current ratings. For relays match coil voltage exactly. Use: Infineon, Vishay, ON Semi, TI, STMicro, Rohm, Renesas, Omron, TE Connectivity, Panasonic, Murata, Wurth, Kemet. 4 keySpecs each, first is main rating. Self-check before responding.\nRespond ONLY with raw JSON:\n{\"category\":\"Type\",\"interpretation\":\"summary\",\"designTip\":\"tip\",\"results\":[{\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"type\":\"Type\",\"keySpecs\":[{\"label\":\"L\",\"value\":\"V\",\"unit\":\"U\"}],\"package\":\"PKG\",\"rank\":\"top\",\"aeComment\":\"comment\",\"caution\":null,\"applications\":[\"app\"]}]}";

var ALT_SEARCH_SYSTEM = "Find EXACTLY 4 drop-in alternatives. Meet/exceed original specs. Different manufacturers. Must exist on DigiKey. 4 keySpecs each.\nRespond ONLY with raw JSON:\n{\"originalPart\":\"MPN\",\"originalSpecs\":\"specs\",\"alternatives\":[{\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"type\":\"Type\",\"compatibility\":\"drop-in\",\"keySpecs\":[{\"label\":\"L\",\"value\":\"V\",\"unit\":\"U\"}],\"package\":\"PKG\",\"whyAlternative\":\"reason\",\"differences\":\"diffs\"}],\"importantNote\":\"note\"}";

var BOM_SYSTEM = "Generate a complete BOM. Include ALL critical components: power semiconductors, gate drivers, control ICs, regulators, current sensors, bulk capacitors, power inductors, optocouplers, crystals, connectors. NO generic bypass caps. Use exact DigiKey MPNs.\nRespond ONLY with raw JSON:\n{\"projectName\":\"name\",\"description\":\"sentence\",\"voltage\":\"V\",\"power\":\"W\",\"designNotes\":\"notes\",\"totalEstimate\":\"$X-Y\",\"bomItems\":[{\"id\":1,\"function\":\"fn\",\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"description\":\"desc\",\"category\":\"IC\",\"quantity\":1,\"keySpecs\":\"specs\",\"package\":\"PKG\",\"priority\":\"critical\",\"unitPrice\":\"$X\",\"notes\":null}]}";

// =============================================
// HEALTH
// =============================================
app.get("/api/health", function(req, res) {
  res.json({ status: "ok", service: "PartTensor", gemini: !!process.env.GEMINI_API_KEY, time: new Date().toISOString() });
});

// =============================================
// CHECK PLAN
// =============================================
app.post("/api/check-plan", async function(req, res) {
  try {
    var userId = req.body.userId;
    if (!userId) return res.json({ plan: "guest", limits: PLANS.guest });
    var plan = await getUserPlan(userId);
    res.json({ plan: plan, limits: PLANS[plan] || PLANS.free });
  } catch (err) { res.json({ plan: "free", limits: PLANS.free }); }
});

// =============================================
// TRACK
// =============================================
app.post("/api/track", async function(req, res) {
  try { var data = req.body; if (!data.action || !data.partNumber) return res.json({ ok: false }); await trackInteraction(data); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false }); }
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
    var existing = await supabaseQuery("GET", "part_performance", null, "query_normalized=eq." + encodeURIComponent(queryNorm) + "&part_number=eq." + encodeURIComponent(partNumber) + "&select=id,total_score,negative_feedback");
    if (existing && existing.length > 0) {
      var updates = { total_score: (existing[0].total_score || 0) + score, last_updated: new Date().toISOString() };
      if (feedback === "bad") updates.negative_feedback = (existing[0].negative_feedback || 0) + 1;
      await supabaseQuery("PATCH", "part_performance", updates, "id=eq." + existing[0].id);
    } else {
      await supabaseQuery("POST", "part_performance", { query_normalized: queryNorm, component_type: req.body.componentType || "", part_number: partNumber, manufacturer: req.body.manufacturer || "", total_score: score, negative_feedback: feedback === "bad" ? 1 : 0, buy_clicks: 0, datasheet_clicks: 0, card_clicks: 0, alternative_searches: 0, last_updated: new Date().toISOString() });
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
// EXCEL BOM UPLOAD (Pro+ only)
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
      } catch (e) { console.error("Alt lookup failed for " + row.partNumber); }
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
// RAZORPAY - All plans
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
    var planName = planKey.startsWith("team") ? "team" : "pro";
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

// =============================================
// API ACCESS (Enterprise)
// External developers can call this endpoint
// =============================================
app.post("/api/v1/search", async function(req, res) {
  try {
    var apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(401).json({ error: "API key required. Get yours at parttensor.com/api" });
    // Verify API key against Supabase
    var keyResult = await supabaseQuery("GET", "api_keys", null, "key=eq." + encodeURIComponent(apiKey) + "&active=eq.true&select=user_id,plan,requests_today,requests_limit");
    if (!keyResult || keyResult.length === 0) return res.status(401).json({ error: "Invalid or inactive API key" });
    var keyData = keyResult[0];
    if (keyData.requests_today >= keyData.requests_limit) return res.status(429).json({ error: "Daily API limit reached. Upgrade your plan at parttensor.com" });
    // Increment request count
    await supabaseQuery("PATCH", "api_keys", { requests_today: keyData.requests_today + 1 }, "key=eq." + encodeURIComponent(apiKey));
    var query = req.body.query;
    if (!query) return res.status(400).json({ error: "query is required" });
    var requiredSpecs = extractRequiredSpecs(query);
    var componentType = detectComponentType(query);
    var geminiData = await searchPartsWithGemini(query, componentType, requiredSpecs);
    var parts = null;
    if (geminiData && geminiData.results) {
      parts = await validateWithDigiKey(geminiData.results, requiredSpecs);
      if (parts.length < 2) {
        var cr = await callClaude(CLAUDE_PART_SYSTEM, [{ role: "user", content: query }], 3000);
        var cd = cr.text ? extractJSON(cr.text) : null;
        if (cd && cd.results) parts = await validateWithDigiKey(cd.results, requiredSpecs);
      }
    }
    if (!parts || parts.length === 0) return res.json({ results: [], message: "No parts found" });
    var stockResults = await Promise.all(parts.map(function(p) { return fetchStock(p.partNumber); }));
    var stockMap = {};
    parts.forEach(function(p, i) { stockMap[p.partNumber] = stockResults[i]; });
    res.json({ results: parts, stockData: stockMap, query: query, componentType: componentType });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    console.log("\n[CHAT]", message.substring(0, 80), "plan:", clientPlan);

    // Get actual plan from DB for logged-in users
    var plan = clientPlan;
    if (userId && (clientPlan === "free" || clientPlan === "pro" || clientPlan === "team")) {
      plan = await getUserPlan(userId);
    }
    var planLimits = PLANS[plan] || PLANS.guest;

    // USAGE LIMITS
    var identifier = userId || (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown");
    if (plan === "guest" || plan === "free") {
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

    var requiredSpecs = extractRequiredSpecs(message);
    var componentType = detectComponentType(message);

    // Classify intent
    var contextSummary = history.slice(-6).map(function(m) { return (m.role === "user" ? "User: " : "AI: ") + (m.content || "").substring(0, 150); }).join("\n");
    var intentInput = history.length > 0 ? "Previous:\n" + contextSummary + "\n\nNew message: " + message : message;
    var intentResult = await callClaude(INTENT_SYSTEM, [{ role: "user", content: intentInput }], 300);
    var intent = "part_search"; var detectedPN = null;
    if (intentResult.text) { var ip = extractJSON(intentResult.text); if (ip) { intent = ip.intent || "part_search"; detectedPN = ip.partNumber || null; } }
    if (isComponentQuery(message) && intent === "general") intent = "part_search";
    console.log("Intent:", intent, "Plan:", plan, "Component:", componentType);

    // Block non-electronics
    if (intent === "general") {
      return res.json({ text: "I am PartTensor, a hardware engineering AI. I can help you find electronic components, check live stock, generate BOMs, and answer circuit design questions.", intent: intent, mode: "text" });
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

    // FIND ALTERNATIVES - check limit
    if (intent === "find_alternatives") {
      var pn = detectedPN || extractPartNumber(message);
      if (!pn) return res.json({ text: "Could you specify the part number you want alternatives for?", intent: intent, mode: "question" });
      var altResult = await callClaude(ALT_SEARCH_SYSTEM, [{ role: "user", content: "Find alternatives for " + pn + ". Context: " + message }], 3000);
      var altData = altResult.text ? extractJSON(altResult.text) : null;
      if (!altData || !altData.alternatives) return res.json({ text: "Could not find alternatives for " + pn + ". Please try again.", intent: intent, mode: "text" });
      var altParts = await validateWithDigiKey(altData.alternatives || [], {});
      var altStockResults = await Promise.all(altParts.map(function(p) { return fetchStock(p.partNumber); }));
      var altStockMap = {};
      altParts.forEach(function(p, i) { altStockMap[p.partNumber] = altStockResults[i]; });
      altParts.sort(function(a, b) { var aS = altStockMap[a.partNumber] ? altStockMap[a.partNumber].totalStock : 0; var bS = altStockMap[b.partNumber] ? altStockMap[b.partNumber].totalStock : 0; return (bS > 0 ? 1 : 0) - (aS > 0 ? 1 : 0) || bS - aS; });
      return res.json({ text: "Here are **" + altParts.length + " alternatives** for **" + pn + "** validated on DigiKey:", mode: "alt", originalPart: altData.originalPart || pn, originalSpecs: altData.originalSpecs || "", alternatives: altParts, stockData: altStockMap, importantNote: altData.importantNote || null, intent: intent, query: message, componentType: componentType, requiredVoltage: requiredSpecs.voltage || null, requiredCurrent: requiredSpecs.current || null });
    }

    // GENERATE BOM - Pro+ only
    if (intent === "generate_bom") {
      if (!planLimits.bom) {
        return res.json({ text: "BOM generation is a Pro feature.", intent: intent, mode: "upgrade", feature: "bom", requiredPlan: "pro" });
      }
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

    // PART SEARCH - Gemini + DigiKey + Claude fallback
    var searchCacheKey = "search_" + message.toLowerCase().trim().substring(0, 80);
    var searchCached = getCached(aiCache, searchCacheKey);
    var parts = null; var searchMeta = {}; var source = "cache";

    if (searchCached) {
      parts = searchCached.results || [];
      searchMeta = { category: searchCached.category, interpretation: searchCached.interpretation, designTip: searchCached.designTip };
    } else {
      var geminiData = await searchPartsWithGemini(message, componentType, requiredSpecs);
      if (geminiData && geminiData.results && geminiData.results.length > 0) {
        var geminiValidated = await validateWithDigiKey(geminiData.results, requiredSpecs);
        if (geminiValidated.length >= 2) {
          parts = geminiValidated;
          searchMeta = { category: geminiData.category || componentType || "", interpretation: geminiData.interpretation || "", designTip: geminiData.designTip || "" };
          source = "gemini";
        } else { source = "claude_fallback"; }
      } else { source = "claude_fallback"; }

      if (source === "claude_fallback") {
        var claudeResult = await callClaude(CLAUDE_PART_SYSTEM, fullMessages, 3000);
        var claudeData = claudeResult.text ? extractJSON(claudeResult.text) : null;
        if (!claudeData || !claudeData.results) {
          var fallback = await callClaude(ENGINEERING_SYSTEM, fullMessages, 1500);
          return res.json({ text: fallback.text || "Could not find specific parts. Please provide more details.", intent: intent, mode: "text" });
        }
        var claudeValidated = await validateWithDigiKey(claudeData.results, requiredSpecs);
        parts = claudeValidated.length >= 1 ? claudeValidated : claudeData.results;
        searchMeta = { category: claudeData.category || componentType || "", interpretation: claudeData.interpretation || "", designTip: claudeData.designTip || "" };
      }
      setCache(aiCache, searchCacheKey, Object.assign({ results: parts }, searchMeta), AI_TTL);
    }

    var learnedData = await getLearnedRankings(message, componentType);
    if (learnedData.length > 0) parts = applyLearnedRanking(parts, learnedData);

    var stockPromises = parts.map(function(p) { return fetchStock(p.partNumber); });
    var stockResults2 = await Promise.all(stockPromises);
    var stockDataMap = {};
    parts.forEach(function(p, i) { stockDataMap[p.partNumber] = stockResults2[i]; });
    parts = parts.slice().sort(function(a, b) {
      var aS = stockDataMap[a.partNumber] ? stockDataMap[a.partNumber].totalStock : 0;
      var bS = stockDataMap[b.partNumber] ? stockDataMap[b.partNumber].totalStock : 0;
      return (bS > 0 ? 1 : 0) - (aS > 0 ? 1 : 0) || bS - aS;
    });

    return res.json({
      text: "Found **" + parts.length + " parts** with live stock from Digi-Key and Mouser:",
      mode: "search", category: searchMeta.category || componentType || "", interpretation: searchMeta.interpretation || "", designTip: searchMeta.designTip || "",
      results: parts, stockData: stockDataMap, intent: intent, query: message, componentType: componentType,
      requiredVoltage: requiredSpecs.voltage || null, requiredCurrent: requiredSpecs.current || null, source: source,
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
  console.log("Plans: Guest=5/day Free=20/day Pro=unlimited Team=unlimited Enterprise=API");
  console.log("Part search: Gemini+Google -> DigiKey validate -> Claude fallback\n");
});
