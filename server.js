const express = require("express");
const cors = require("cors");
require("dotenv").config();

console.log("=== PartTensor Backend Starting ===");
console.log("Anthropic:", process.env.ANTHROPIC_API_KEY ? "OK" : "MISSING");
console.log("DigiKey:", process.env.DIGIKEY_CLIENT_ID ? "OK" : "MISSING");
console.log("Mouser:", process.env.MOUSER_API_KEY ? "OK" : "MISSING");
console.log("Supabase:", process.env.SUPABASE_URL ? "OK" : "MISSING");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

var stockCache = {};
var aiCache = {};
var STOCK_TTL = 2 * 60 * 60 * 1000;
var AI_TTL = 12 * 60 * 60 * 1000;

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
    if (!res.ok) {
      var err = await res.text();
      console.error("Supabase error:", res.status, err.substring(0, 200));
      return null;
    }
    if (method === "POST" && res.status === 201) return true;
    var text = await res.text();
    return text ? JSON.parse(text) : true;
  } catch (e) {
    console.error("Supabase query failed:", e.message);
    return null;
  }
}

// Store interaction in Supabase
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

    // Update part_performance score
    var score = 0;
    if (data.action === "buy_dk" || data.action === "buy_mouser") score = 10;
    else if (data.action === "datasheet") score = 5;
    else if (data.action === "card_click") score = 2;
    else if (data.action === "alternative_search") score = -3;
    else if (data.action === "negative_feedback") score = -8;

    // Position bonus - clicking result #1 is less impressive than clicking result #4
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
      else if (data.action === "alternative_search") updates.alternative_searches = (rec.alternative_searches || 0) + 1;
      else if (data.action === "negative_feedback") updates.negative_feedback = (rec.negative_feedback || 0) + 1;
      await supabaseQuery("PATCH", "part_performance", updates, "id=eq." + rec.id);
    } else {
      var newRec = {
        query_normalized: queryNorm,
        component_type: data.componentType || "",
        required_voltage: data.requiredVoltage || null,
        required_current: data.requiredCurrent || null,
        part_number: data.partNumber || "",
        manufacturer: data.manufacturer || "",
        buy_clicks: (data.action === "buy_dk" || data.action === "buy_mouser") ? 1 : 0,
        datasheet_clicks: data.action === "datasheet" ? 1 : 0,
        card_clicks: data.action === "card_click" ? 1 : 0,
        alternative_searches: data.action === "alternative_search" ? 1 : 0,
        negative_feedback: data.action === "negative_feedback" ? 1 : 0,
        total_score: score,
        last_updated: new Date().toISOString(),
      };
      await supabaseQuery("POST", "part_performance", newRec);
    }
    console.log("Tracked:", data.action, data.partNumber, "score:", score);
  } catch (e) {
    console.error("trackInteraction failed:", e.message);
  }
}

// Get learned rankings for a query
async function getLearnedRankings(query, componentType) {
  try {
    var queryNorm = (query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var results = await supabaseQuery("GET", "part_performance", null,
      "query_normalized=eq." + encodeURIComponent(queryNorm) + "&total_score=gt.0&order=total_score.desc&limit=10&select=part_number,manufacturer,total_score,buy_clicks,datasheet_clicks"
    );
    if (!results || results.length === 0) {
      // Try component type match if no exact query match
      if (componentType) {
        results = await supabaseQuery("GET", "part_performance", null,
          "component_type=eq." + encodeURIComponent(componentType) + "&total_score=gt.5&order=total_score.desc&limit=10&select=part_number,manufacturer,total_score,buy_clicks"
        );
      }
    }
    return results || [];
  } catch (e) {
    console.error("getLearnedRankings failed:", e.message);
    return [];
  }
}

// Boost results based on learned data
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
// DIGIKEY TOKEN
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
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.DIGIKEY_CLIENT_ID,
        client_secret: process.env.DIGIKEY_CLIENT_SECRET,
      }),
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

// =============================================
// STOCK LOOKUPS
// =============================================
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
  var dk = results[0];
  var mo = results[1];
  var total = (dk ? dk.stock : 0) + (mo ? mo.stock : 0);
  var bestPrice = null;
  var bestPriceSource = null;
  if (dk && dk.price) { bestPrice = dk.price; bestPriceSource = "Digi-Key"; }
  if (mo && mo.price) {
    var mv = parseFloat((mo.price || "999").replace(/[^0-9.]/g, "")) || 999;
    var cv = parseFloat((bestPrice || "999").replace(/[^0-9.]/g, "")) || 999;
    if (mv < cv) { bestPrice = mo.price; bestPriceSource = "Mouser"; }
  }
  return {
    found: total > 0,
    totalStock: total,
    bestPrice: bestPrice,
    bestPriceSource: bestPriceSource,
    digikey: dk,
    mouser: mo,
    octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(mpn),
  };
}

// =============================================
// HELPERS
// =============================================
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
  var maM = lower.match(/(\d+(?:\.\d+)?)\s*ma\b/gi) || [];
  if (maM.length > 0 && !specs.current) { var mas = maM.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v); }); if (mas.length > 0) specs.currentMA = Math.max.apply(null, mas); }
  var ufM = lower.match(/(\d+(?:\.\d+)?)\s*uf\b/gi) || [];
  if (ufM.length > 0) specs.capacitanceUF = parseFloat(ufM[0]);
  var uhM = lower.match(/(\d+(?:\.\d+)?)\s*uh\b/gi) || [];
  if (uhM.length > 0) specs.inductanceUH = parseFloat(uhM[0]);
  return specs;
}

function detectComponentType(query) {
  var q = query.toLowerCase();
  q = q.replace(/for\s+(motor|pfc|inverter|converter|charger|driver|controller|amplifier|supply|circuit|switching|drive|load|battery|solar|power)[^,]*/g, "");
  if (q.includes("igbt")) return "igbt";
  if (q.includes("mosfet") || q.includes(" fet") || q.includes("nmos")) {
    if (q.includes("p-channel") || q.includes("pmos")) return "mosfet_p";
    return "mosfet_n";
  }
  if (q.includes("pnp")) return "bjt_pnp";
  if (q.includes("npn") || q.includes("bjt") || (q.includes("transistor") && !q.includes("mosfet"))) return "bjt_npn";
  if (q.includes("schottky")) return "diode_schottky";
  if (q.includes("zener")) return "diode_zener";
  if (q.includes("diode") || q.includes("rectifier")) return "diode_rectifier";
  if (q.includes("gate driver") || q.includes("gate drive ic")) return "gate_driver";
  if (q.includes("op-amp") || q.includes("opamp") || q.includes("op amp")) return "opamp";
  if (q.includes("comparator")) return "comparator";
  if (q.includes("ldo") || (q.includes("linear regulator") && !q.includes("switching"))) return "ldo";
  if (q.includes("dc-dc") || q.includes("buck") || q.includes("boost") || q.includes("switching regulator")) return "dcdc_buck";
  if (q.includes("electrolytic")) return "cap_electrolytic";
  if (q.includes("tantalum")) return "cap_tantalum";
  if (q.includes("ceramic") || q.includes("mlcc")) return "cap_ceramic";
  if (q.includes("capacitor") || q.match(/\d+\s*(uf|nf|pf)\b/)) return "cap_ceramic";
  if (q.includes("inductor") || q.match(/\d+\s*(uh|nh|mh)\b/)) return "inductor";
  if (q.includes("resistor")) return "resistor_smd";
  if (q.includes("current sensor")) return "current_sensor";
  if (q.includes("temperature sensor")) return "temp_sensor";
  return null;
}

// =============================================
// CALL AI
// =============================================
async function callAI(system, messages, maxTokens) {
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
    } catch (err) {
      if (attempt < 3) await new Promise(function(r) { setTimeout(r, 2000); });
    }
  }
  return { error: "All retries failed." };
}

// =============================================
// SYSTEM PROMPTS
// =============================================
var INTENT_SYSTEM = "You classify hardware engineering queries. Consider full conversation context. If the new message is a follow-up refinement (like 'only in stock', 'cheaper', 'different package', 'find alternatives'), classify it as the SAME intent as the previous turn. Any message asking for a component, part, chip, MOSFET, op-amp, capacitor, inductor, resistor, diode, regulator, sensor, or any electronic part MUST be classified as part_search. Respond ONLY with JSON: {\"intent\":\"part_search|find_alternatives|generate_bom|circuit_question|calculation|correction|general\",\"partNumber\":\"extracted part number or null\",\"needsMoreInfo\":false,\"followUpQuestion\":null}";

var ENGINEERING_SYSTEM = "You are PartTensor, a senior hardware application engineer AI. Help engineers with component selection, circuit design, calculations, and troubleshooting. Be direct, technical and precise. Use real formulas and examples. Format with **bold headers** and - bullet points. Keep answers focused and practical.";

var PART_SEARCH_SYSTEM = "You are a senior hardware application engineer. Suggest EXACTLY 4 real electronic parts that best match the user request.\n\nCRITICAL RULES:\n1. Before suggesting any part, verify its datasheet specs from your training knowledge.\n2. If user asks for 100V, ONLY suggest parts with Vds/Vce/Vrrm >= 100V.\n3. If user asks for 30A, ONLY suggest parts with Id/Ic/If >= 30A.\n4. For capacitors: suggest parts closest to requested capacitance value.\n5. For inductors: suggest parts closest to requested inductance value.\n6. For op-amps: GBW must meet or exceed requested value.\n7. For LDOs: output voltage must match, current must meet or exceed.\n8. Prefer parts closest to requested specs - for 100V 30A prefer 100-120V 30-40A over 250V 150A.\n9. Only suggest parts from: Infineon, Vishay, ON Semi, TI, STMicro, Rohm, Renesas, Nexperia, Microchip, Murata, Wurth, Panasonic, Kemet.\n10. Only suggest parts that actually exist on Digi-Key.\n\nSELF-CHECK: For each part verify - Does it meet voltage requirement? Does it meet current requirement? Is value close to requested?\n\nRespond ONLY with raw JSON starting with {:\n{\"category\":\"N-Channel MOSFET\",\"interpretation\":\"one sentence\",\"designTip\":\"one tip\",\"results\":[{\"partNumber\":\"IRF540NPBF\",\"manufacturer\":\"Vishay\",\"type\":\"N-Channel MOSFET\",\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"100\",\"unit\":\"V\"},{\"label\":\"ID\",\"value\":\"33\",\"unit\":\"A\"},{\"label\":\"RDS(on)\",\"value\":\"44\",\"unit\":\"mOhm\"},{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],\"package\":\"TO-220\",\"rank\":\"top\",\"aeComment\":\"100V/33A meets requirements. Popular in motor drives.\",\"caution\":null,\"applications\":[\"Motor Drive\"]}]}";

var ALT_SEARCH_SYSTEM = "You are a senior hardware application engineer. Find EXACTLY 4 alternative parts for the given part number. All alternatives must meet or exceed the original part specs. Use different manufacturers. Only suggest parts that actually exist on Digi-Key. Sort by best drop-in compatibility first.\nRespond ONLY with raw JSON starting with {:\n{\"originalPart\":\"IRF540NPBF\",\"originalSpecs\":\"100V 33A TO-220\",\"alternatives\":[{\"partNumber\":\"FQP33N10\",\"manufacturer\":\"ON Semi\",\"type\":\"N-Channel MOSFET\",\"compatibility\":\"drop-in\",\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"100\",\"unit\":\"V\"},{\"label\":\"ID\",\"value\":\"33\",\"unit\":\"A\"},{\"label\":\"RDS(on)\",\"value\":\"52\",\"unit\":\"mOhm\"},{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],\"package\":\"TO-220\",\"whyAlternative\":\"Direct replacement same pinout\",\"differences\":\"Slightly higher Rds(on)\"}],\"importantNote\":\"Verify gate drive\"}";

var BOM_SYSTEM = "You are a senior hardware application engineer. Generate a complete Bill of Materials for the described system. Include ALL critical components needed: power semiconductors (MOSFETs, diodes, IGBTs), gate drivers, control ICs, voltage regulators, current sensors, specialized capacitors (bulk electrolytic, film), power inductors, optocouplers, crystals, connectors. NO generic 100nF bypass caps, NO generic pull-up resistors unless critical. Use exact Digi-Key part numbers. Include 4 keySpecs per part.\nRespond ONLY with raw JSON starting with {:\n{\"projectName\":\"name\",\"description\":\"sentence\",\"voltage\":\"V\",\"power\":\"W\",\"designNotes\":\"notes\",\"totalEstimate\":\"$X-Y\",\"bomItems\":[{\"id\":1,\"function\":\"High Side Gate Driver\",\"partNumber\":\"IR2184SPBF\",\"manufacturer\":\"Infineon\",\"description\":\"600V Half Bridge Gate Driver\",\"category\":\"IC\",\"quantity\":2,\"keySpecs\":\"600V 2A 200ns SO-8\",\"package\":\"SO-8\",\"priority\":\"critical\",\"unitPrice\":\"$1.20\",\"notes\":null}]}";

// =============================================
// HEALTH
// =============================================
app.get("/api/health", function(req, res) {
  res.json({ status: "ok", service: "PartTensor", time: new Date().toISOString() });
});

// =============================================
// TRACK INTERACTION ENDPOINT
// Called from frontend when user clicks anything
// =============================================
app.post("/api/track", async function(req, res) {
  try {
    var data = req.body;
    if (!data.action || !data.partNumber) return res.json({ ok: false });
    await trackInteraction(data);
    res.json({ ok: true });
  } catch (err) {
    console.error("Track error:", err.message);
    res.json({ ok: false });
  }
});

// =============================================
// STOCK BULK ENDPOINT
// For BOM stock loading in background
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
  } catch (err) {
    console.error("Stock bulk error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// MAIN CHAT ENDPOINT
// =============================================
app.post("/api/chat", async function(req, res) {
  try {
    var message = req.body.message;
    var history = req.body.history || [];
    var sessionId = req.body.sessionId || "anon";
    var isCorrection = req.body.isCorrection || false;
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
        var usageRes = await supabaseQuery("GET", "usage_limits", null,
          "identifier=eq." + encodeURIComponent(identifier) + "&select=id,message_count,last_reset,plan"
        );
        var usage = usageRes && usageRes[0];
        var currentCount = 0;

        if (usage) {
          if (usage.last_reset !== today) {
            await supabaseQuery("PATCH", "usage_limits", { message_count: 1, last_reset: today }, "id=eq." + usage.id);
            currentCount = 1;
          } else {
            currentCount = (usage.message_count || 0) + 1;
            var limit = identifierType === "user" ? FREE_LIMIT : GUEST_LIMIT;
            if (currentCount > limit) {
              return res.json({ error: "Daily limit reached", limitReached: true, plan: plan });
            }
            await supabaseQuery("PATCH", "usage_limits", { message_count: currentCount }, "id=eq." + usage.id);
          }
        } else {
          await supabaseQuery("POST", "usage_limits", { identifier: identifier, identifier_type: identifierType, message_count: 1, last_reset: today, plan: plan });
          currentCount = 1;
        }
        console.log("Usage:", identifier.substring(0, 20), "count:", currentCount, "plan:", plan);
      } catch (e) {
        console.error("Usage check failed:", e.message);
        // Don't block if usage check fails
      }
    }

    var requiredSpecs = extractRequiredSpecs(message);
    var componentType = detectComponentType(message);

    // Classify intent
    var contextSummary = history.slice(-6).map(function(m) { return (m.role === "user" ? "User: " : "AI: ") + (m.content || "").substring(0, 150); }).join("\n");
    var intentInput = history.length > 0 ? "Previous conversation:\n" + contextSummary + "\n\nNew message: " + message : message;
    var intentResult = await callAI(INTENT_SYSTEM, [{ role: "user", content: intentInput }], 300);
    var intent = "part_search";
    var needsMoreInfo = false;
    var followUpQuestion = null;
    var detectedPN = null;
    if (intentResult.text) {
      var ip = extractJSON(intentResult.text);
      if (ip) { intent = ip.intent || "part_search"; needsMoreInfo = ip.needsMoreInfo || false; followUpQuestion = ip.followUpQuestion || null; detectedPN = ip.partNumber || null; }
    }
    console.log("Intent:", intent, "PN:", detectedPN, "Specs:", JSON.stringify(requiredSpecs));

    if (needsMoreInfo && followUpQuestion && !isCorrection) return res.json({ text: followUpQuestion, intent: intent, mode: "question" });

    var fullMessages = [];
    history.slice(-8).forEach(function(m) { if (m.content) fullMessages.push({ role: m.role, content: m.content }); });
    fullMessages.push({ role: "user", content: message });

    // ENGINEERING QUESTIONS
    if (intent === "circuit_question" || intent === "calculation" || intent === "general" || intent === "correction") {
      var engSystem = ENGINEERING_SYSTEM;
      if (isCorrection) engSystem += " The user is correcting a previous response. Address their feedback directly.";
      var engResult = await callAI(engSystem, fullMessages, 2000);
      if (engResult.error) return res.status(503).json({ error: engResult.error });
      return res.json({ text: engResult.text, intent: intent, mode: "text" });
    }

    // FIND ALTERNATIVES
    if (intent === "find_alternatives") {
      var pn = detectedPN || extractPartNumber(message);
      if (!pn) return res.json({ text: "Could you specify the part number you want alternatives for?", intent: intent, mode: "question" });

      var altResult = await callAI(ALT_SEARCH_SYSTEM, [{ role: "user", content: "Find alternatives for " + pn + ". Context: " + message }], 3000);
      var altData = altResult.text ? extractJSON(altResult.text) : null;
      if (!altData || !altData.alternatives) return res.json({ text: "Could not find alternatives for " + pn + ". Please try again.", intent: intent, mode: "text" });

      var altParts = altData.alternatives || [];

      // Apply learned ranking
      var learnedAlt = await getLearnedRankings("alternatives for " + pn, componentType);
      if (learnedAlt.length > 0) altParts = applyLearnedRanking(altParts, learnedAlt);

      // Fetch stock in parallel
      var altStockPromises = altParts.map(function(p) { return fetchStock(p.partNumber); });
      var altStockResults = await Promise.all(altStockPromises);
      var altStockMap = {};
      altParts.forEach(function(p, i) { altStockMap[p.partNumber] = altStockResults[i]; });

      // Sort by stock then learned score
      altParts = altParts.sort(function(a, b) {
        var aStock = altStockMap[a.partNumber] ? altStockMap[a.partNumber].totalStock : 0;
        var bStock = altStockMap[b.partNumber] ? altStockMap[b.partNumber].totalStock : 0;
        var aIn = aStock > 0 ? 1 : 0;
        var bIn = bStock > 0 ? 1 : 0;
        if (bIn !== aIn) return bIn - aIn;
        return bStock - aStock;
      });

      return res.json({
        text: "Here are **" + altParts.length + " alternatives** for **" + pn + "** with live stock from Digi-Key and Mouser:",
        mode: "alt",
        originalPart: altData.originalPart || pn,
        originalSpecs: altData.originalSpecs || "",
        alternatives: altParts,
        stockData: altStockMap,
        importantNote: altData.importantNote || null,
        intent: intent,
        sessionId: sessionId,
        query: message,
        componentType: componentType,
        requiredVoltage: requiredSpecs.voltage || null,
        requiredCurrent: requiredSpecs.current || null,
      });
    }

    // GENERATE BOM
    if (intent === "generate_bom") {
      var bomCacheKey = "bom_" + message.toLowerCase().trim().substring(0, 80);
      var bomCached = getCached(aiCache, bomCacheKey);
      if (bomCached) { console.log("BOM cache hit"); return res.json(bomCached); }

      console.log("Generating BOM...");
      var bomResult = await callAI(BOM_SYSTEM, fullMessages, 4000);
      var bomData = bomResult.text ? extractJSON(bomResult.text) : null;
      if (!bomData || !bomData.bomItems) return res.json({ text: "Could you describe the application in more detail?", intent: intent, mode: "question" });

      // Return BOM immediately, stock loads in background via /api/stock-bulk
      bomData.stockData = {};
      var bomResponse = Object.assign({
        text: "Here is a complete BOM for your **" + bomData.projectName + "** -- " + bomData.bomItems.length + " critical components. Stock loading...",
        intent: intent,
        loadStockInBackground: true,
      }, bomData);
      setCache(aiCache, bomCacheKey, bomResponse, AI_TTL);
      return res.json(bomResponse);
    }

    // PART SEARCH
    var searchCacheKey = "search_" + message.toLowerCase().trim().substring(0, 80);
    var searchCached = getCached(aiCache, searchCacheKey);

    var parts = null;

    if (searchCached) {
      console.log("Search cache hit");
      parts = searchCached.results || [];
    } else {
      console.log("AI part search...");
      var searchResult = await callAI(PART_SEARCH_SYSTEM, fullMessages, 3000);
      var searchData = searchResult.text ? extractJSON(searchResult.text) : null;
      if (!searchData || !searchData.results) {
        var fallback = await callAI(ENGINEERING_SYSTEM, fullMessages, 1500);
        return res.json({ text: fallback.text || "Could not find specific parts. Please provide more details.", intent: intent, mode: "text" });
      }
      parts = searchData.results || [];

      // Cache AI results (before stock)
      setCache(aiCache, searchCacheKey, searchData, AI_TTL);
    }

    // Apply learned ranking from Supabase
    var learnedData = await getLearnedRankings(message, componentType);
    if (learnedData.length > 0) {
      console.log("Applying learned ranking from", learnedData.length, "historical interactions");
      parts = applyLearnedRanking(parts, learnedData);
    }

    // Fetch stock in parallel for all parts
    var stockPromises = parts.map(function(p) { return fetchStock(p.partNumber); });
    var stockResults = await Promise.all(stockPromises);
    var stockDataMap = {};
    parts.forEach(function(p, i) { stockDataMap[p.partNumber] = stockResults[i]; });

    // Sort: in-stock first, then by stock quantity
    parts = parts.sort(function(a, b) {
      var aStock = stockDataMap[a.partNumber] ? stockDataMap[a.partNumber].totalStock : 0;
      var bStock = stockDataMap[b.partNumber] ? stockDataMap[b.partNumber].totalStock : 0;
      var aIn = aStock > 0 ? 1 : 0;
      var bIn = bStock > 0 ? 1 : 0;
      if (bIn !== aIn) return bIn - aIn;
      return bStock - aStock;
    });

    return res.json({
      text: "Found **" + parts.length + " parts** with live stock from Digi-Key and Mouser:",
      mode: "search",
      category: (searchCached && searchCached.category) || componentType || "",
      interpretation: (searchCached && searchCached.interpretation) || "",
      designTip: (searchCached && searchCached.designTip) || "",
      results: parts,
      stockData: stockDataMap,
      intent: intent,
      sessionId: sessionId,
      query: message,
      componentType: componentType,
      requiredVoltage: requiredSpecs.voltage || null,
      requiredCurrent: requiredSpecs.current || null,
    });

  } catch (err) {
    console.error("Chat error:", err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ error: "Server error: " + err.message });
  }
});

// Keep alive ping for Render free tier
setInterval(async function() {
  try {
    var fetch = (await import("node-fetch")).default;
    await fetch("https://parttensor-backend.onrender.com/api/health");
    console.log("Keep-alive ping");
  } catch (e) {}
}, 14 * 60 * 1000);


// =============================================
// RAZORPAY PAYMENT
// =============================================
async function getRazorpayInstance() {
  try {
    var Razorpay = require("razorpay");
    return new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  } catch (e) {
    console.error("Razorpay not installed:", e.message);
    return null;
  }
}

// Create Razorpay order
app.post("/api/create-order", async function(req, res) {
  try {
    var plan = req.body.plan || "monthly";
    var userId = req.body.userId;
    var email = req.body.email;

    var amounts = { monthly: 9900, yearly: 79900 }; // in paise
    var amount = amounts[plan] || 9900;

    var razorpay = await getRazorpayInstance();
    if (!razorpay) {
      return res.status(500).json({ error: "Payment not configured yet. Contact support." });
    }

    var order = await razorpay.orders.create({
      amount: amount,
      currency: "INR",
      receipt: "pt_" + Date.now(),
      notes: { userId: userId || "", email: email || "", plan: plan },
    });

    console.log("Razorpay order created:", order.id, "plan:", plan);
    res.json({ orderId: order.id, amount: amount, currency: "INR", plan: plan });
  } catch (err) {
    console.error("Create order error:", err.message);
    res.status(500).json({ error: "Could not create payment order: " + err.message });
  }
});

// Verify payment and activate plan
app.post("/api/verify-payment", async function(req, res) {
  try {
    var razorpayOrderId = req.body.razorpay_order_id;
    var razorpayPaymentId = req.body.razorpay_payment_id;
    var razorpaySignature = req.body.razorpay_signature;
    var userId = req.body.userId;
    var plan = req.body.plan || "monthly";

    // Verify signature
    var crypto = require("crypto");
    var expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(razorpayOrderId + "|" + razorpayPaymentId)
      .digest("hex");

    if (expectedSignature !== razorpaySignature) {
      console.error("Payment signature mismatch");
      return res.status(400).json({ error: "Payment verification failed" });
    }

    console.log("Payment verified:", razorpayPaymentId, "user:", userId, "plan:", plan);

    // Calculate expiry
    var expiresAt = new Date();
    if (plan === "yearly") {
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    } else {
      expiresAt.setMonth(expiresAt.getMonth() + 1);
    }

    // Update usage_limits to paid
    if (userId) {
      var existing = await supabaseQuery("GET", "usage_limits", null,
        "identifier=eq." + encodeURIComponent(userId) + "&select=id"
      );
      if (existing && existing.length > 0) {
        await supabaseQuery("PATCH", "usage_limits", {
          plan: "paid",
          message_count: 0,
          last_reset: new Date().toISOString().split("T")[0],
        }, "id=eq." + existing[0].id);
      } else {
        await supabaseQuery("POST", "usage_limits", {
          identifier: userId,
          identifier_type: "user",
          message_count: 0,
          last_reset: new Date().toISOString().split("T")[0],
          plan: "paid",
        });
      }

      // Record payment
      await supabaseQuery("POST", "payments", {
        user_id: userId,
        plan: plan,
        status: "active",
        razorpay_payment_id: razorpayPaymentId,
        razorpay_order_id: razorpayOrderId,
        expires_at: expiresAt.toISOString(),
      });
    }

    res.json({ success: true, plan: plan, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    console.error("Verify payment error:", err.message);
    res.status(500).json({ error: "Payment verification failed: " + err.message });
  }
});

// Check user plan
app.post("/api/check-plan", async function(req, res) {
  try {
    var userId = req.body.userId;
    if (!userId) return res.json({ plan: "free" });

    var result = await supabaseQuery("GET", "usage_limits", null,
      "identifier=eq." + encodeURIComponent(userId) + "&select=plan,message_count"
    );

    if (result && result.length > 0) {
      return res.json({ plan: result[0].plan || "free", messageCount: result[0].message_count || 0 });
    }
    res.json({ plan: "free", messageCount: 0 });
  } catch (err) {
    res.json({ plan: "free", messageCount: 0 });
  }
});

// =============================================
// PART FEEDBACK - thumbs up/down
// =============================================
app.post("/api/feedback", async function(req, res) {
  try {
    var partNumber = req.body.partNumber;
    var manufacturer = req.body.manufacturer;
    var query = req.body.query;
    var feedback = req.body.feedback; // "good" or "bad"
    var sessionId = req.body.sessionId;
    var componentType = req.body.componentType;

    if (!partNumber || !feedback) return res.status(400).json({ error: "partNumber and feedback required" });

    console.log("Feedback:", feedback, partNumber, "query:", (query || "").substring(0, 40));

    // Score: good = +5, bad = -10 (bad is stronger signal)
    var score = feedback === "good" ? 5 : -10;
    var queryNorm = (query || "").toLowerCase().trim().replace(/\s+/g, " ");

    // Update part_performance
    var existing = await supabaseQuery("GET", "part_performance", null,
      "query_normalized=eq." + encodeURIComponent(queryNorm) + "&part_number=eq." + encodeURIComponent(partNumber) + "&select=id,total_score,negative_feedback,buy_clicks"
    );

    if (existing && existing.length > 0) {
      var rec = existing[0];
      var updates = {
        total_score: (rec.total_score || 0) + score,
        last_updated: new Date().toISOString(),
      };
      if (feedback === "bad") updates.negative_feedback = (rec.negative_feedback || 0) + 1;
      await supabaseQuery("PATCH", "part_performance", updates, "id=eq." + rec.id);
    } else {
      await supabaseQuery("POST", "part_performance", {
        query_normalized: queryNorm,
        component_type: componentType || "",
        part_number: partNumber,
        manufacturer: manufacturer || "",
        total_score: score,
        negative_feedback: feedback === "bad" ? 1 : 0,
        buy_clicks: 0,
        datasheet_clicks: 0,
        card_clicks: 0,
        alternative_searches: 0,
        last_updated: new Date().toISOString(),
      });
    }

    // If bad feedback - also flag in part_catalog so it won't be suggested
    if (feedback === "bad") {
      var catalogEntry = await supabaseQuery("GET", "part_catalog", null,
        "part_number=eq." + encodeURIComponent(partNumber) + "&select=id,negative_count"
      );
      if (catalogEntry && catalogEntry.length > 0) {
        var negCount = (catalogEntry[0].negative_count || 0) + 1;
        await supabaseQuery("PATCH", "part_catalog", {
          negative_count: negCount,
          // Flag as suppress if 3+ bad feedbacks
          suppressed: negCount >= 3 ? true : false,
        }, "id=eq." + catalogEntry[0].id);
      }
    }

    res.json({ ok: true, feedback: feedback, partNumber: partNumber });
  } catch (err) {
    console.error("Feedback error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log("\nPartTensor backend running on port " + PORT);
  console.log("  GET  /api/health");
  console.log("  POST /api/chat");
  console.log("  POST /api/track      - track user interactions");
  console.log("  POST /api/stock-bulk - bulk stock for BOM\n");
});
