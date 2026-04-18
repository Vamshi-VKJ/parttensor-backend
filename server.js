const express = require("express");
const cors = require("cors");
require("dotenv").config();

console.log("=== PartTensor Backend Starting ===");
console.log("Anthropic:", process.env.ANTHROPIC_API_KEY ? "OK" : "MISSING");
  console.log("Perplexity:", process.env.PERPLEXITY_API_KEY ? "OK" : "MISSING");
console.log("DigiKey:", process.env.DIGIKEY_CLIENT_ID ? "OK" : "MISSING");
console.log("Mouser:", process.env.MOUSER_API_KEY ? "OK" : "MISSING");
console.log("Supabase:", process.env.SUPABASE_URL ? "OK" : "MISSING");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

var stockCache = {};
var aiCache = {};
var STOCK_TTL = 2 * 60 * 60 * 1000;
var AI_TTL = 6 * 60 * 60 * 1000; // shorter for Perplexity since data is real-time

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
// SUPABASE CLIENT
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
    if (!res.ok) { var err = await res.text(); console.error("Supabase error:", res.status, err.substring(0, 200)); return null; }
    if (method === "POST" && res.status === 201) return true;
    var text = await res.text();
    return text ? JSON.parse(text) : true;
  } catch (e) { console.error("Supabase query failed:", e.message); return null; }
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
    else if (data.action === "alternative_search") score = -3;
    else if (data.action === "negative_feedback") score = -8;
    if (data.position && score > 0) score += (data.position - 1) * 2;
    var queryNorm = (data.query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var existing = await supabaseQuery("GET", "part_performance", null,
      "query_normalized=eq." + encodeURIComponent(queryNorm) + "&part_number=eq." + encodeURIComponent(data.partNumber || "") + "&select=id,buy_clicks,datasheet_clicks,card_clicks,alternative_searches,negative_feedback,total_score"
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
        query_normalized: queryNorm, component_type: data.componentType || "",
        required_voltage: data.requiredVoltage || null, required_current: data.requiredCurrent || null,
        part_number: data.partNumber || "", manufacturer: data.manufacturer || "",
        buy_clicks: (data.action === "buy_dk" || data.action === "buy_mouser") ? 1 : 0,
        datasheet_clicks: data.action === "datasheet" ? 1 : 0,
        card_clicks: data.action === "card_click" ? 1 : 0,
        alternative_searches: data.action === "alternative_search" ? 1 : 0,
        negative_feedback: data.action === "negative_feedback" ? 1 : 0,
        total_score: score, last_updated: new Date().toISOString(),
      });
    }
  } catch (e) { console.error("trackInteraction failed:", e.message); }
}

async function getLearnedRankings(query, componentType) {
  try {
    var queryNorm = (query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var results = await supabaseQuery("GET", "part_performance", null,
      "query_normalized=eq." + encodeURIComponent(queryNorm) + "&total_score=gt.0&order=total_score.desc&limit=10&select=part_number,total_score"
    );
    if (!results || results.length === 0) {
      if (componentType) {
        results = await supabaseQuery("GET", "part_performance", null,
          "component_type=eq." + encodeURIComponent(componentType) + "&total_score=gt.5&order=total_score.desc&limit=10&select=part_number,total_score"
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
    var aScore = scoreMap[a.partNumber] || 0;
    var bScore = scoreMap[b.partNumber] || 0;
    return bScore - aScore;
  });
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
    if (data.access_token) {
      digikeyToken = data.access_token;
      digikeyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      console.log("DigiKey token refreshed");
      return digikeyToken;
    }
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
      var r2 = { found: true, stock: best2.QuantityAvailable || 0, price: p2 ? "$" + parseFloat(p2).toFixed(3) : null, url: best2.ProductUrl || "" };
      setCache(stockCache, "dk_" + mpn, r2, STOCK_TTL);
      return r2;
    }
    var data = await res.json();
    var product = data.Product || data;
    var unitPrice = product.UnitPrice || (product.StandardPricing && product.StandardPricing[0] && product.StandardPricing[0].UnitPrice) || null;
    var result = { found: true, stock: product.QuantityAvailable || 0, price: unitPrice ? "$" + parseFloat(unitPrice).toFixed(3) : null, url: product.ProductUrl || "" };
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
  var dk = results[0];
  var mo = results[1];
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
// PERPLEXITY - Real-time part search
// =============================================
async function searchPartsWithPerplexity(query, componentType) {
  try {
    var fetch = (await import("node-fetch")).default;
    console.log("Perplexity search:", query);

    var systemPrompt = "You are a hardware component search engine. When asked for electronic parts, search for REAL parts currently available on DigiKey or Mouser. Return ONLY parts that exist right now on DigiKey or Mouser with current stock. Focus on finding the most recent and best-matched components. Return EXACTLY 4 parts in this JSON format with NO other text:\n{\"category\":\"component category\",\"interpretation\":\"one sentence summary of what user needs\",\"designTip\":\"one practical engineering tip\",\"results\":[{\"partNumber\":\"EXACT_DIGIKEY_MPN\",\"manufacturer\":\"Manufacturer Name\",\"type\":\"Component Type\",\"keySpecs\":[{\"label\":\"Key Spec 1\",\"value\":\"value\",\"unit\":\"unit\"},{\"label\":\"Key Spec 2\",\"value\":\"value\",\"unit\":\"unit\"},{\"label\":\"Key Spec 3\",\"value\":\"value\",\"unit\":\"unit\"},{\"label\":\"Package\",\"value\":\"package\",\"unit\":\"\"}],\"package\":\"package type\",\"rank\":\"top\",\"aeComment\":\"Why this part is a good choice\",\"caution\":null,\"applications\":[\"Application 1\"]}]}";

    var userPrompt = "Find me the best 4 electronic components for: " + query + "\nSearch DigiKey and Mouser for currently available parts. Include only parts with real stock. Return exact manufacturer part numbers (MPN) as listed on DigiKey. Return JSON only.";

    var res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.PERPLEXITY_API_KEY,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    if (!res.ok) {
      var errText = await res.text();
      console.error("Perplexity error:", res.status, errText.substring(0, 200));
      return null;
    }

    var data = await res.json();
    var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    console.log("Perplexity raw response length:", text.length);

    // Extract JSON from response
    var clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    var depth = 0, start = -1, end = -1;
    for (var i = 0; i < clean.length; i++) {
      if (clean[i] === "{") { if (depth === 0) start = i; depth++; }
      else if (clean[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (start === -1 || end === -1) { console.error("No JSON found in Perplexity response"); return null; }

    try {
      var parsed = JSON.parse(clean.substring(start, end + 1));
      if (parsed && parsed.results && parsed.results.length > 0) {
        console.log("Perplexity found", parsed.results.length, "parts:", parsed.results.map(function(p) { return p.partNumber; }).join(", "));
        return parsed;
      }
    } catch (e) { console.error("Perplexity JSON parse failed:", e.message); return null; }
    return null;
  } catch (e) {
    console.error("Perplexity search failed:", e.message);
    return null;
  }
}

// =============================================
// CLAUDE AI - for non-search tasks
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
      var text = (aiData.content || []).map(function(b) { return b.text || ""; }).join("");
      return { text: text };
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
  var lower = query.toLowerCase();
  var specs = {};
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
  if (q.includes("diode") || q.includes("rectifier")) return "diode";
  if (q.includes("capacitor") || q.match(/\d+\s*(uf|nf|pf)\b/)) return "capacitor";
  if (q.includes("inductor") || q.match(/\d+\s*(uh|nh|mh)\b/)) return "inductor";
  if (q.includes("resistor")) return "resistor";
  if (q.includes("op-amp") || q.includes("opamp")) return "opamp";
  if (q.includes("ldo") || q.includes("regulator")) return "ldo";
  if (q.includes("transistor") || q.includes("bjt")) return "bjt";
  if (q.includes("gate driver")) return "gate_driver";
  if (q.includes("sensor")) return "sensor";
  return null;
}

var COMPONENT_KEYWORDS = ["relay", "mosfet", "capacitor", "resistor", "inductor", "diode", "transistor", "op-amp", "opamp", "ldo", "regulator", "sensor", "connector", "switch", "fuse", "crystal", "oscillator", "driver", "controller", "igbt", "thyristor", "triac", "optocoupler", "transformer", "ic", "chip", "bjt", "scr", "module", "rectifier", "varistor", "thermistor", "potentiometer", "encoder", "actuator", "solenoid", "motor driver", "gate driver", "voltage reference", "comparator", "adc", "dac", "mux", "buffer"];

function isComponentQuery(message) {
  var lower = message.toLowerCase();
  for (var i = 0; i < COMPONENT_KEYWORDS.length; i++) {
    if (lower.includes(COMPONENT_KEYWORDS[i])) return true;
  }
  return false;
}

// =============================================
// SYSTEM PROMPTS (Claude)
// =============================================
var INTENT_SYSTEM = "You classify hardware engineering queries into exactly one intent. RULES:\n1. ANY message mentioning a component name or asking to find/recommend/suggest a part MUST be 'part_search'. This includes: relay, MOSFET, capacitor, resistor, inductor, diode, transistor, op-amp, LDO, regulator, sensor, connector, switch, fuse, crystal, oscillator, driver, controller, IGBT, optocoupler, transformer, IC, chip, BJT, module, rectifier.\n2. Only 'circuit_question' if asking HOW something works with NO component request.\n3. Only 'calculation' if asking to calculate a value with NO component request.\n4. Only 'general' if completely unrelated to electronics - respond with a polite refusal.\n5. Follow-up refinements keep the SAME intent as previous turn.\nRespond ONLY with JSON: {\"intent\":\"part_search|find_alternatives|generate_bom|circuit_question|calculation|correction|general\",\"partNumber\":null,\"needsMoreInfo\":false,\"followUpQuestion\":null}";

var ENGINEERING_SYSTEM = "You are PartTensor, a senior hardware application engineer AI. Help engineers with component selection, circuit design, calculations, and troubleshooting. Be direct, technical and precise. Format with **bold headers** and - bullet points. Keep answers focused and practical.";

var ALT_SEARCH_SYSTEM = "You are a senior hardware application engineer. Find EXACTLY 4 alternative parts for the given part number. All alternatives must meet or exceed the original part specs. Use different manufacturers. Only suggest parts that actually exist on DigiKey.\nRespond ONLY with raw JSON:\n{\"originalPart\":\"MPN\",\"originalSpecs\":\"specs summary\",\"alternatives\":[{\"partNumber\":\"MPN\",\"manufacturer\":\"Name\",\"type\":\"Type\",\"compatibility\":\"drop-in\",\"keySpecs\":[{\"label\":\"L\",\"value\":\"V\",\"unit\":\"U\"}],\"package\":\"PKG\",\"whyAlternative\":\"reason\",\"differences\":\"differences\"}],\"importantNote\":\"note\"}";

var BOM_SYSTEM = "You are a senior hardware application engineer. Generate a complete Bill of Materials. Include ALL critical components: power semiconductors, gate drivers, control ICs, voltage regulators, current sensors, bulk capacitors, power inductors, optocouplers, crystals, connectors. NO generic bypass caps or pull-up resistors. Use exact DigiKey part numbers.\nRespond ONLY with raw JSON:\n{\"projectName\":\"name\",\"description\":\"sentence\",\"voltage\":\"V\",\"power\":\"W\",\"designNotes\":\"notes\",\"totalEstimate\":\"$X-Y\",\"bomItems\":[{\"id\":1,\"function\":\"function\",\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"description\":\"desc\",\"category\":\"IC\",\"quantity\":1,\"keySpecs\":\"specs\",\"package\":\"PKG\",\"priority\":\"critical\",\"unitPrice\":\"$X\",\"notes\":null}]}";

// =============================================
// HEALTH
// =============================================
app.get("/api/health", function(req, res) {
  res.json({ status: "ok", service: "PartTensor", time: new Date().toISOString() });
});

// =============================================
// TRACK INTERACTION
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
// PART FEEDBACK
// =============================================
app.post("/api/feedback", async function(req, res) {
  try {
    var partNumber = req.body.partNumber;
    var feedback = req.body.feedback;
    var query = req.body.query;
    var componentType = req.body.componentType;
    var manufacturer = req.body.manufacturer;
    if (!partNumber || !feedback) return res.status(400).json({ error: "partNumber and feedback required" });
    var score = feedback === "good" ? 5 : -10;
    var queryNorm = (query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var existing = await supabaseQuery("GET", "part_performance", null,
      "query_normalized=eq." + encodeURIComponent(queryNorm) + "&part_number=eq." + encodeURIComponent(partNumber) + "&select=id,total_score,negative_feedback"
    );
    if (existing && existing.length > 0) {
      var rec = existing[0];
      var updates = { total_score: (rec.total_score || 0) + score, last_updated: new Date().toISOString() };
      if (feedback === "bad") updates.negative_feedback = (rec.negative_feedback || 0) + 1;
      await supabaseQuery("PATCH", "part_performance", updates, "id=eq." + rec.id);
    } else {
      await supabaseQuery("POST", "part_performance", {
        query_normalized: queryNorm, component_type: componentType || "",
        part_number: partNumber, manufacturer: manufacturer || "",
        total_score: score, negative_feedback: feedback === "bad" ? 1 : 0,
        buy_clicks: 0, datasheet_clicks: 0, card_clicks: 0, alternative_searches: 0,
        last_updated: new Date().toISOString(),
      });
    }
    if (feedback === "bad") {
      var catalogEntry = await supabaseQuery("GET", "part_catalog", null, "part_number=eq." + encodeURIComponent(partNumber) + "&select=id,negative_count");
      if (catalogEntry && catalogEntry.length > 0) {
        var negCount = (catalogEntry[0].negative_count || 0) + 1;
        await supabaseQuery("PATCH", "part_catalog", { negative_count: negCount, suppressed: negCount >= 3 }, "id=eq." + catalogEntry[0].id);
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// STOCK BULK (for BOM background loading)
// =============================================
app.post("/api/stock-bulk", async function(req, res) {
  try {
    var partNumbers = req.body.partNumbers || [];
    if (partNumbers.length === 0) return res.json({});
    console.log("Bulk stock lookup for", partNumbers.length, "parts");
    var stockPromises = partNumbers.map(function(pn) { return fetchStock(pn); });
    var stockResults = await Promise.all(stockPromises);
    var stockMap = {};
    partNumbers.forEach(function(pn, i) { stockMap[pn] = stockResults[i]; });
    res.json(stockMap);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// RAZORPAY
// =============================================
app.post("/api/create-order", async function(req, res) {
  try {
    var plan = req.body.plan || "monthly";
    var userId = req.body.userId;
    var email = req.body.email;
    var amounts = { monthly: 9900, yearly: 79900 };
    var amount = amounts[plan] || 9900;
    var Razorpay = require("razorpay");
    var razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    var order = await razorpay.orders.create({ amount: amount, currency: "INR", receipt: "pt_" + Date.now(), notes: { userId: userId || "", email: email || "", plan: plan } });
    res.json({ orderId: order.id, amount: amount, currency: "INR", plan: plan });
  } catch (err) { res.status(500).json({ error: "Could not create order: " + err.message }); }
});

app.post("/api/verify-payment", async function(req, res) {
  try {
    var crypto = require("crypto");
    var expectedSig = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "").update(req.body.razorpay_order_id + "|" + req.body.razorpay_payment_id).digest("hex");
    if (expectedSig !== req.body.razorpay_signature) return res.status(400).json({ error: "Payment verification failed" });
    var userId = req.body.userId;
    var plan = req.body.plan || "monthly";
    var expiresAt = new Date();
    if (plan === "yearly") expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    else expiresAt.setMonth(expiresAt.getMonth() + 1);
    if (userId) {
      var existing = await supabaseQuery("GET", "usage_limits", null, "identifier=eq." + encodeURIComponent(userId) + "&select=id");
      if (existing && existing.length > 0) {
        await supabaseQuery("PATCH", "usage_limits", { plan: "paid", message_count: 0, last_reset: new Date().toISOString().split("T")[0] }, "id=eq." + existing[0].id);
      } else {
        await supabaseQuery("POST", "usage_limits", { identifier: userId, identifier_type: "user", message_count: 0, last_reset: new Date().toISOString().split("T")[0], plan: "paid" });
      }
      await supabaseQuery("POST", "payments", { user_id: userId, plan: plan, status: "active", razorpay_payment_id: req.body.razorpay_payment_id, razorpay_order_id: req.body.razorpay_order_id, expires_at: expiresAt.toISOString() });
    }
    res.json({ success: true, plan: plan, expiresAt: expiresAt.toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// MAIN CHAT ENDPOINT
// =============================================
app.post("/api/chat", async function(req, res) {
  try {
    var message = req.body.message;
    var history = req.body.history || [];
    var sessionId = req.body.sessionId || "anon";
    var userId = req.body.userId || null;
    var plan = req.body.plan || "guest";
    if (!message) return res.status(400).json({ error: "Message is required" });
    console.log("\n[CHAT]", message.substring(0, 80));

    // CHECK USAGE LIMITS
    var GUEST_LIMIT = 10;
    var FREE_LIMIT = 50;
    var identifier = userId || (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown");
    var identifierType = userId ? "user" : "ip";
    if (plan !== "paid") {
      try {
        var today = new Date().toISOString().split("T")[0];
        var usageRes = await supabaseQuery("GET", "usage_limits", null, "identifier=eq." + encodeURIComponent(identifier) + "&select=id,message_count,last_reset,plan");
        var usage = usageRes && usageRes[0];
        var currentCount = 0;
        if (usage) {
          if (usage.last_reset !== today) {
            await supabaseQuery("PATCH", "usage_limits", { message_count: 1, last_reset: today }, "id=eq." + usage.id);
            currentCount = 1;
          } else {
            currentCount = (usage.message_count || 0) + 1;
            var limit = identifierType === "user" ? FREE_LIMIT : GUEST_LIMIT;
            if (currentCount > limit) return res.json({ error: "Daily limit reached", limitReached: true, plan: plan });
            await supabaseQuery("PATCH", "usage_limits", { message_count: currentCount }, "id=eq." + usage.id);
          }
        } else {
          await supabaseQuery("POST", "usage_limits", { identifier: identifier, identifier_type: identifierType, message_count: 1, last_reset: today, plan: plan });
          currentCount = 1;
        }
        console.log("Usage:", identifier.substring(0, 20), "count:", currentCount);
      } catch (e) { console.error("Usage check failed:", e.message); }
    }

    var requiredSpecs = extractRequiredSpecs(message);
    var componentType = detectComponentType(message);

    // Classify intent
    var contextSummary = history.slice(-6).map(function(m) { return (m.role === "user" ? "User: " : "AI: ") + (m.content || "").substring(0, 150); }).join("\n");
    var intentInput = history.length > 0 ? "Previous:\n" + contextSummary + "\n\nNew message: " + message : message;
    var intentResult = await callClaude(INTENT_SYSTEM, [{ role: "user", content: intentInput }], 300);
    var intent = "part_search";
    var detectedPN = null;
    if (intentResult.text) {
      var ip = extractJSON(intentResult.text);
      if (ip) { intent = ip.intent || "part_search"; detectedPN = ip.partNumber || null; }
    }

    // Force part_search if component keyword detected
    if (isComponentQuery(message) && intent === "general") intent = "part_search";
    console.log("Intent:", intent, "Component:", componentType);

    // Block non-electronics
    if (intent === "general") {
      return res.json({ text: "I am PartTensor, a hardware engineering AI. I can help you find electronic components, check live stock, generate BOMs, and answer circuit design questions. What can I help you with?", intent: intent, mode: "text" });
    }

    var fullMessages = [];
    history.slice(-8).forEach(function(m) { if (m.content) fullMessages.push({ role: m.role, content: m.content }); });
    fullMessages.push({ role: "user", content: message });

    // ENGINEERING QUESTIONS - use Claude
    if (intent === "circuit_question" || intent === "calculation" || intent === "correction") {
      var engResult = await callClaude(ENGINEERING_SYSTEM, fullMessages, 2000);
      if (engResult.error) return res.status(503).json({ error: engResult.error });
      return res.json({ text: engResult.text, intent: intent, mode: "text" });
    }

    // FIND ALTERNATIVES - use Claude
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
      altParts.sort(function(a, b) {
        var aS = altStockMap[a.partNumber] ? altStockMap[a.partNumber].totalStock : 0;
        var bS = altStockMap[b.partNumber] ? altStockMap[b.partNumber].totalStock : 0;
        return (bS > 0 ? 1 : 0) - (aS > 0 ? 1 : 0) || bS - aS;
      });
      return res.json({ text: "Here are **" + altParts.length + " alternatives** for **" + pn + "** with live stock:", mode: "alt", originalPart: altData.originalPart || pn, originalSpecs: altData.originalSpecs || "", alternatives: altParts, stockData: altStockMap, importantNote: altData.importantNote || null, intent: intent, query: message, componentType: componentType, requiredVoltage: requiredSpecs.voltage || null, requiredCurrent: requiredSpecs.current || null });
    }

    // GENERATE BOM - use Claude
    if (intent === "generate_bom") {
      var bomCacheKey = "bom_" + message.toLowerCase().trim().substring(0, 80);
      var bomCached = getCached(aiCache, bomCacheKey);
      if (bomCached) return res.json(bomCached);
      var bomResult = await callClaude(BOM_SYSTEM, fullMessages, 4000);
      var bomData = bomResult.text ? extractJSON(bomResult.text) : null;
      if (!bomData || !bomData.bomItems) return res.json({ text: "Could you describe the application in more detail? Voltage, current, and key requirements?", intent: intent, mode: "question" });
      bomData.stockData = {};
      var bomResponse = Object.assign({ text: "Here is a complete BOM for **" + bomData.projectName + "** -- " + bomData.bomItems.length + " critical components. Stock loading...", intent: intent, loadStockInBackground: true }, bomData);
      setCache(aiCache, bomCacheKey, bomResponse, AI_TTL);
      return res.json(bomResponse);
    }

    // PART SEARCH - use Perplexity for real-time results
    var searchCacheKey = "search_" + message.toLowerCase().trim().substring(0, 80);
    var searchCached = getCached(aiCache, searchCacheKey);
    var parts = null;
    var searchMeta = {};

    if (searchCached) {
      console.log("Search cache hit");
      parts = searchCached.results || [];
      searchMeta = { category: searchCached.category, interpretation: searchCached.interpretation, designTip: searchCached.designTip };
    } else {
      // Try Perplexity first for real-time results
      var perplexityData = await searchPartsWithPerplexity(message, componentType);

      if (perplexityData && perplexityData.results && perplexityData.results.length > 0) {
        parts = perplexityData.results;
        searchMeta = { category: perplexityData.category || componentType || "", interpretation: perplexityData.interpretation || "", designTip: perplexityData.designTip || "" };
        console.log("Using Perplexity results");
      } else {
        // Fallback to Claude if Perplexity fails
        console.log("Perplexity failed, falling back to Claude...");
        var CLAUDE_PART_SYSTEM = "You are a senior hardware application engineer. Suggest EXACTLY 4 real electronic parts. Rules: ALL parts must meet or exceed requested specs. Only suggest parts from major manufacturers that exist on DigiKey. Include 4 keySpecs per part.\nRespond ONLY with raw JSON:\n{\"category\":\"Type\",\"interpretation\":\"summary\",\"designTip\":\"tip\",\"results\":[{\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"type\":\"Type\",\"keySpecs\":[{\"label\":\"L\",\"value\":\"V\",\"unit\":\"U\"}],\"package\":\"PKG\",\"rank\":\"top\",\"aeComment\":\"comment\",\"caution\":null,\"applications\":[\"app\"]}]}";
        var claudeResult = await callClaude(CLAUDE_PART_SYSTEM, fullMessages, 3000);
        var claudeData = claudeResult.text ? extractJSON(claudeResult.text) : null;
        if (!claudeData || !claudeData.results) {
          var fallback = await callClaude(ENGINEERING_SYSTEM, fullMessages, 1500);
          return res.json({ text: fallback.text || "Could not find specific parts. Please provide more details.", intent: intent, mode: "text" });
        }
        parts = claudeData.results;
        searchMeta = { category: claudeData.category || "", interpretation: claudeData.interpretation || "", designTip: claudeData.designTip || "" };
        console.log("Using Claude fallback results");
      }

      setCache(aiCache, searchCacheKey, Object.assign({ results: parts }, searchMeta), AI_TTL);
    }

    // Apply learned ranking from user behaviour
    var learnedData = await getLearnedRankings(message, componentType);
    if (learnedData.length > 0) {
      console.log("Applying learned ranking from", learnedData.length, "interactions");
      parts = applyLearnedRanking(parts, learnedData);
    }

    // Fetch live stock for all parts in parallel
    var stockPromises = parts.map(function(p) { return fetchStock(p.partNumber); });
    var stockResults = await Promise.all(stockPromises);
    var stockDataMap = {};
    parts.forEach(function(p, i) { stockDataMap[p.partNumber] = stockResults[i]; });

    // Sort: in-stock first
    parts = parts.slice().sort(function(a, b) {
      var aS = stockDataMap[a.partNumber] ? stockDataMap[a.partNumber].totalStock : 0;
      var bS = stockDataMap[b.partNumber] ? stockDataMap[b.partNumber].totalStock : 0;
      return (bS > 0 ? 1 : 0) - (aS > 0 ? 1 : 0) || bS - aS;
    });

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
      source: searchCached ? "cache" : (parts.length > 0 ? "perplexity" : "claude"),
    });

  } catch (err) {
    console.error("Chat error:", err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ error: "Server error: " + err.message });
  }
});

// =============================================
// TEST EMAIL ENDPOINT
// =============================================
app.post("/api/test-email", async function(req, res) {
  try {
    var fetch = (await import("node-fetch")).default;
    var to = req.body.to;
    var result = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "onboarding@resend.dev", to: to, subject: "PartTensor Test Email", html: "<h2>It works!</h2><p>PartTensor email is configured correctly.</p>" }),
    });
    var data = await result.json();
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Keep Render alive
setInterval(async function() {
  try {
    var fetch = (await import("node-fetch")).default;
    await fetch("https://parttensor-backend.onrender.com/api/health");
    console.log("Keep-alive ping");
  } catch (e) {}
}, 14 * 60 * 1000);

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log("\nPartTensor backend running on port " + PORT);
  console.log("  GET  /api/health");
  console.log("  POST /api/chat        - Perplexity (part search) + Claude (everything else)");
  console.log("  POST /api/track       - interaction tracking");
  console.log("  POST /api/feedback    - part feedback");
  console.log("  POST /api/stock-bulk  - BOM stock loading");
  console.log("  POST /api/create-order, /api/verify-payment - Razorpay\n");
});
