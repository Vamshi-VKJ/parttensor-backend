const express = require("express");
const cors = require("cors");
require("dotenv").config();

console.log("=== PartTensor Backend Starting ===");
console.log("Anthropic:", process.env.ANTHROPIC_API_KEY ? "OK" : "MISSING");
console.log("DigiKey:", process.env.DIGIKEY_CLIENT_ID ? "OK" : "MISSING");
console.log("Mouser:", process.env.MOUSER_API_KEY ? "OK" : "MISSING");

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
    console.error("DigiKey token error:", JSON.stringify(data).substring(0, 200));
    return null;
  } catch (e) {
    console.error("DigiKey token failed:", e.message);
    return null;
  }
}

// =============================================
// DIGIKEY STOCK LOOKUP
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
      // Try keyword search as fallback
      var res2 = await fetch("https://api.digikey.com/products/v4/search/keyword", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD", "Content-Type": "application/json" },
        body: JSON.stringify({ Keywords: mpn, Limit: 3, Offset: 0 }),
      });
      if (!res2.ok) return null;
      var data2 = await res2.json();
      var products = data2.Products || [];
      if (products.length === 0) return null;
      var best = products.reduce(function(a, b) { return (b.QuantityAvailable || 0) > (a.QuantityAvailable || 0) ? b : a; });
      var p2 = best.UnitPrice || (best.StandardPricing && best.StandardPricing[0] && best.StandardPricing[0].UnitPrice) || null;
      var result2 = { found: true, stock: best.QuantityAvailable || 0, price: p2 ? "$" + parseFloat(p2).toFixed(3) : null, url: best.ProductUrl || "" };
      setCache(stockCache, "dk_" + mpn, result2, STOCK_TTL);
      return result2;
    }
    var data = await res.json();
    var product = data.Product || data;
    var unitPrice = product.UnitPrice || (product.StandardPricing && product.StandardPricing[0] && product.StandardPricing[0].UnitPrice) || null;
    var result = { found: true, stock: product.QuantityAvailable || 0, price: unitPrice ? "$" + parseFloat(unitPrice).toFixed(3) : null, url: product.ProductUrl || "" };
    setCache(stockCache, "dk_" + mpn, result, STOCK_TTL);
    return result;
  } catch (e) {
    console.error("DK lookup failed for " + mpn + ":", e.message);
    return null;
  }
}

// =============================================
// MOUSER STOCK LOOKUP
// =============================================
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
  } catch (e) {
    console.error("Mouser lookup failed for " + mpn + ":", e.message);
    return null;
  }
}

// =============================================
// FETCH STOCK FROM BOTH DISTRIBUTORS IN PARALLEL
// =============================================
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
// EXTRACT JSON FROM AI RESPONSE
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

// =============================================
// EXTRACT REQUIRED SPECS FROM QUERY
// =============================================
function extractRequiredSpecs(query) {
  var lower = query.toLowerCase();
  var specs = {};
  var vM = lower.match(/(\d+(?:\.\d+)?)\s*v\b/gi) || [];
  if (vM.length > 0) { var vs = vM.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; }); if (vs.length > 0) specs.voltage = Math.max.apply(null, vs); }
  var aM = lower.match(/(\d+(?:\.\d+)?)\s*a\b/gi) || [];
  if (aM.length > 0) { var as2 = aM.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; }); if (as2.length > 0) specs.current = Math.max.apply(null, as2); }
  var maM = lower.match(/(\d+(?:\.\d+)?)\s*ma\b/gi) || [];
  if (maM.length > 0 && !specs.current) { var mas = maM.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v); }); if (mas.length > 0) specs.currentMA = Math.max.apply(null, mas); }
  var wM = lower.match(/(\d+(?:\.\d+)?)\s*w\b/gi) || [];
  if (wM.length > 0) { var ws = wM.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0.1; }); if (ws.length > 0) specs.power = Math.max.apply(null, ws); }
  var ufM = lower.match(/(\d+(?:\.\d+)?)\s*uf\b/gi) || [];
  if (ufM.length > 0) specs.capacitanceUF = parseFloat(ufM[0]);
  var nfM = lower.match(/(\d+(?:\.\d+)?)\s*nf\b/gi) || [];
  if (nfM.length > 0 && !specs.capacitanceUF) specs.capacitanceNF = parseFloat(nfM[0]);
  var uhM = lower.match(/(\d+(?:\.\d+)?)\s*uh\b/gi) || [];
  if (uhM.length > 0) specs.inductanceUH = parseFloat(uhM[0]);
  var mhzM = lower.match(/(\d+(?:\.\d+)?)\s*mhz\b/gi) || [];
  if (mhzM.length > 0 && (lower.includes("gbw") || lower.includes("bandwidth"))) specs.gbwMHz = parseFloat(mhzM[0]);
  var mvM = lower.match(/(\d+(?:\.\d+)?)\s*mv\b/gi) || [];
  if (mvM.length > 0 && (lower.includes("dropout") || lower.includes("ldo"))) specs.dropoutMV = parseFloat(mvM[0]);
  return specs;
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
        body: JSON.stringify({ model: model, max_tokens: maxTokens || 2000, system: system, messages: messages }),
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

var PART_SEARCH_SYSTEM = "You are a senior hardware application engineer. Suggest EXACTLY 4 real electronic parts that best match the user request.\n\nCRITICAL RULES - FOLLOW EXACTLY:\n1. Before suggesting any part, mentally verify its datasheet specs.\n2. If user asks for 100V, ONLY suggest parts with Vds/Vce/Vrrm >= 100V. A 60V part is WRONG.\n3. If user asks for 30A, ONLY suggest parts with Id/Ic/If >= 30A. A 1A part is WRONG.\n4. If user asks for 10uF capacitor, ONLY suggest parts close to 10uF. A 100pF part is WRONG.\n5. If user asks for 10uH inductor, ONLY suggest parts close to 10uH.\n6. For op-amps: GBW must meet or exceed requested value.\n7. For LDOs: output voltage must match, current must meet or exceed.\n8. Prefer parts closest to requested specs. For 100V 30A: prefer 100-120V 30-40A over 200V 150A.\n9. Only suggest parts from: Infineon, Vishay, ON Semi, TI, STMicro, Rohm, Renesas, Nexperia, Microchip, Murata, Wurth, Panasonic, Kemet.\n10. Only suggest parts that actually exist on Digi-Key.\n\nSELF-CHECK before responding: For each part you suggest, verify:\n- Does it meet the voltage requirement? YES/NO\n- Does it meet the current requirement? YES/NO\n- Is the value close to what was requested? YES/NO\nIf any answer is NO, replace that part with a correct one.\n\nRespond ONLY with raw JSON starting with {:\n{\"category\":\"N-Channel MOSFET\",\"interpretation\":\"one sentence summary\",\"designTip\":\"one practical tip\",\"results\":[{\"partNumber\":\"IRF540NPBF\",\"manufacturer\":\"Vishay\",\"type\":\"N-Channel MOSFET\",\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"100\",\"unit\":\"V\"},{\"label\":\"ID\",\"value\":\"33\",\"unit\":\"A\"},{\"label\":\"RDS(on)\",\"value\":\"44\",\"unit\":\"mOhm\"},{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],\"package\":\"TO-220\",\"rank\":\"top\",\"aeComment\":\"100V/33A meets requirements exactly. Standard TO-220 package ideal for motor drives.\",\"caution\":null,\"applications\":[\"Motor Drive\",\"Power Switching\"]}]}";

var ALT_SEARCH_SYSTEM = "You are a senior hardware application engineer. Find EXACTLY 4 alternative parts for the given part number. Rules:\n1. All alternatives must meet or exceed the original part specs.\n2. Use different manufacturers than the original.\n3. Sort by best drop-in compatibility first.\n4. Only suggest parts that actually exist on Digi-Key.\nRespond ONLY with raw JSON starting with {:\n{\"originalPart\":\"IRF540NPBF\",\"originalSpecs\":\"100V 33A TO-220\",\"alternatives\":[{\"partNumber\":\"FQP33N10\",\"manufacturer\":\"ON Semi\",\"type\":\"N-Channel MOSFET\",\"compatibility\":\"drop-in\",\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"100\",\"unit\":\"V\"},{\"label\":\"ID\",\"value\":\"33\",\"unit\":\"A\"},{\"label\":\"RDS(on)\",\"value\":\"52\",\"unit\":\"mOhm\"},{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],\"package\":\"TO-220\",\"whyAlternative\":\"Direct replacement with same pinout\",\"differences\":\"Slightly higher Rds(on)\"}],\"importantNote\":\"Verify gate drive requirements\"}";

var BOM_SYSTEM = "You are a senior hardware application engineer. Generate a complete Bill of Materials. Include only critical components: MOSFETs, ICs, drivers, gate drivers, specialized inductors, bulk capacitors, current sense resistors, crystals, connectors, optocouplers, diodes, sensors. NO generic 100nF caps, NO generic resistors unless critical. Use exact Digi-Key part numbers. Respond ONLY with raw JSON starting with {:\n{\"projectName\":\"24V 10A BLDC Motor Controller\",\"description\":\"Full H-bridge motor controller\",\"voltage\":\"24V\",\"power\":\"240W\",\"designNotes\":\"notes\",\"totalEstimate\":\"$45-65\",\"bomItems\":[{\"id\":1,\"function\":\"Gate Driver\",\"partNumber\":\"IR2184SPBF\",\"manufacturer\":\"Infineon\",\"description\":\"600V Half Bridge Gate Driver\",\"category\":\"IC\",\"quantity\":2,\"keySpecs\":\"600V 2A SO-8\",\"package\":\"SO-8\",\"priority\":\"critical\",\"unitPrice\":\"$1.20\",\"notes\":null}]}";

// =============================================
// HEALTH
// =============================================
app.get("/api/health", function(req, res) {
  res.json({ status: "ok", service: "PartTensor", time: new Date().toISOString() });
});

// =============================================
// MAIN CHAT ENDPOINT
// =============================================
app.post("/api/chat", async function(req, res) {
  try {
    var message = req.body.message;
    var history = req.body.history || [];
    var isCorrection = req.body.isCorrection || false;
    if (!message) return res.status(400).json({ error: "Message is required" });
    console.log("\n[CHAT]", message.substring(0, 80));

    var requiredSpecs = extractRequiredSpecs(message);

    // Classify intent with history context
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

    // ==========================================
    // ENGINEERING QUESTIONS - pure AI response
    // ==========================================
    if (intent === "circuit_question" || intent === "calculation" || intent === "general" || intent === "correction") {
      var engSystem = ENGINEERING_SYSTEM;
      if (isCorrection) engSystem += " The user is correcting a previous response. Address their feedback directly.";
      var engResult = await callAI(engSystem, fullMessages, 2000);
      if (engResult.error) return res.status(503).json({ error: engResult.error });
      return res.json({ text: engResult.text, intent: intent, mode: "text" });
    }

    // ==========================================
    // FIND ALTERNATIVES
    // ==========================================
    if (intent === "find_alternatives") {
      var pn = detectedPN || extractPartNumber(message);
      if (!pn) return res.json({ text: "Could you specify the part number you want alternatives for?", intent: intent, mode: "question" });

      var cacheKey = "alt_" + pn.toUpperCase();
      var cached = getCached(aiCache, cacheKey);
      if (cached) {
        console.log("Alt cache hit for", pn);
        return res.json(cached);
      }

      console.log("Finding alternatives for:", pn);
      var altResult = await callAI(ALT_SEARCH_SYSTEM, [{ role: "user", content: "Find alternatives for " + pn + ". User context: " + message }], 3000);
      var altData = altResult.text ? extractJSON(altResult.text) : null;
      if (!altData || !altData.alternatives) return res.json({ text: "Could not find alternatives for " + pn + ". Please try again.", intent: intent, mode: "text" });

      // Fetch stock for all alternatives in parallel
      var altParts = altData.alternatives || [];
      console.log("Fetching stock for", altParts.length, "alternatives...");
      var altStockPromises = altParts.map(function(p) { return fetchStock(p.partNumber); });
      var altStockResults = await Promise.all(altStockPromises);
      var altStockMap = {};
      altParts.forEach(function(p, i) { altStockMap[p.partNumber] = altStockResults[i]; });

      var altResponse = {
        text: "Here are **" + altParts.length + " alternatives** for **" + pn + "** with real-time stock from Digi-Key and Mouser:",
        mode: "alt",
        originalPart: altData.originalPart || pn,
        originalSpecs: altData.originalSpecs || "",
        alternatives: altParts,
        stockData: altStockMap,
        importantNote: altData.importantNote || null,
        intent: intent,
      };
      setCache(aiCache, cacheKey, altResponse, AI_TTL);
      return res.json(altResponse);
    }

    // ==========================================
    // GENERATE BOM
    // ==========================================
    if (intent === "generate_bom") {
      var bomCacheKey = "bom_" + message.toLowerCase().trim().substring(0, 100);
      var bomCached = getCached(aiCache, bomCacheKey);
      if (bomCached) { console.log("BOM cache hit"); return res.json(bomCached); }

      console.log("Generating BOM...");
      var bomResult = await callAI(BOM_SYSTEM, fullMessages, 4000);
      var bomData = bomResult.text ? extractJSON(bomResult.text) : null;
      if (!bomData || !bomData.bomItems) return res.json({ text: "Could you describe the application in more detail? For example: input voltage, output current, key requirements.", intent: intent, mode: "question" });

      // Fetch stock for all BOM parts in parallel
      var bomPNs = bomData.bomItems.map(function(p) { return p.partNumber; });
      console.log("Fetching stock for", bomPNs.length, "BOM parts...");
      var bomStockPromises = bomPNs.map(function(pn2) { return fetchStock(pn2); });
      var bomStockResults = await Promise.all(bomStockPromises);
      var bomStockMap = {};
      bomPNs.forEach(function(pn2, i) { bomStockMap[pn2] = bomStockResults[i]; });
      bomData.stockData = bomStockMap;

      var bomResponse = Object.assign({
        text: "Here is a **sourcing-ready BOM** for your **" + bomData.projectName + "** -- " + bomData.bomItems.length + " critical components with live stock from Digi-Key and Mouser:",
        intent: intent,
      }, bomData);
      setCache(aiCache, bomCacheKey, bomResponse, AI_TTL);
      return res.json(bomResponse);
    }

    // ==========================================
    // PART SEARCH
    // AI picks correct parts, DigiKey+Mouser verify stock
    // ==========================================
    var searchCacheKey = "search_" + message.toLowerCase().trim().substring(0, 100);
    var searchCached = getCached(aiCache, searchCacheKey);
    if (searchCached) {
      console.log("Search cache hit");
      // Refresh stock data even for cached results
      var cachedPNs = (searchCached.results || []).map(function(p) { return p.partNumber; });
      var freshStockPromises = cachedPNs.map(function(pn3) { return fetchStock(pn3); });
      var freshStockResults = await Promise.all(freshStockPromises);
      var freshStockMap = {};
      cachedPNs.forEach(function(pn3, i) { freshStockMap[pn3] = freshStockResults[i]; });
      searchCached.stockData = freshStockMap;
      return res.json(searchCached);
    }

    console.log("AI part search for:", message.substring(0, 60));
    var searchResult = await callAI(PART_SEARCH_SYSTEM, fullMessages, 3000);
    var searchData = searchResult.text ? extractJSON(searchResult.text) : null;

    if (!searchData || !searchData.results || searchData.results.length === 0) {
      // Fallback to engineering answer
      var fallback = await callAI(ENGINEERING_SYSTEM, fullMessages, 1500);
      return res.json({ text: fallback.text || "Could not find specific parts. Please provide more details about the specs you need.", intent: intent, mode: "text" });
    }

    // Fetch stock for all results in parallel
    var parts = searchData.results || [];
    console.log("AI suggested:", parts.map(function(p) { return p.partNumber; }).join(", "));
    console.log("Fetching stock for", parts.length, "parts...");
    var stockPromises = parts.map(function(p) { return fetchStock(p.partNumber); });
    var stockResults = await Promise.all(stockPromises);
    var stockDataMap = {};
    parts.forEach(function(p, i) { stockDataMap[p.partNumber] = stockResults[i]; });

    // Sort: in-stock first, then by rank order
    parts = parts.sort(function(a, b) {
      var aStock = stockDataMap[a.partNumber] ? stockDataMap[a.partNumber].totalStock : 0;
      var bStock = stockDataMap[b.partNumber] ? stockDataMap[b.partNumber].totalStock : 0;
      var aIn = aStock > 0 ? 1 : 0;
      var bIn = bStock > 0 ? 1 : 0;
      if (bIn !== aIn) return bIn - aIn;
      return bStock - aStock;
    });

    var searchResponse = {
      text: "Found **" + parts.length + " parts** for " + (searchData.interpretation || message.substring(0, 50)) + " -- with live stock from Digi-Key and Mouser:",
      mode: "search",
      category: searchData.category || "",
      interpretation: searchData.interpretation || "",
      designTip: searchData.designTip || "",
      results: parts,
      stockData: stockDataMap,
      intent: intent,
    };

    setCache(aiCache, searchCacheKey, searchResponse, AI_TTL);
    return res.json(searchResponse);

  } catch (err) {
    console.error("Chat error:", err.message, err.stack);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// =============================================
// EXCEL BOM UPLOAD
// =============================================
app.post("/api/excel-bom", express.raw({ type: "*/*", limit: "10mb" }), async function(req, res) {
  try {
    var fileContent = req.body.toString("utf8");
    var lines = fileContent.split("\n").filter(function(l) { return l.trim(); });
    if (lines.length === 0) return res.status(400).json({ error: "Empty file" });
    var headers = lines[0].split(",").map(function(h) { return h.replace(/"/g, "").trim().toLowerCase(); });
    var pnColIdx = 0;
    var pnKeywords = ["part number","pn","mpn","part no","partno","part#","component","part_number"];
    for (var ki = 0; ki < pnKeywords.length; ki++) { for (var hi = 0; hi < headers.length; hi++) { if (headers[hi].indexOf(pnKeywords[ki]) !== -1) { pnColIdx = hi; break; } } }
    var partNumbers = [];
    for (var li = 1; li < lines.length; li++) { var cols = lines[li].split(",").map(function(c) { return c.replace(/"/g, "").trim(); }); if (cols[pnColIdx]) partNumbers.push(cols[pnColIdx]); }
    if (partNumbers.length === 0) return res.status(400).json({ error: "No part numbers found. Make sure your CSV has a Part Number column." });
    console.log("Excel BOM:", partNumbers.length, "parts");

    var results = [];
    var limit = Math.min(partNumbers.length, 20);
    for (var pi = 0; pi < limit; pi++) {
      var pn = partNumbers[pi];
      if (!pn) continue;
      var stock = await fetchStock(pn);
      var row = { partNumber: pn, description: "", category: "", keySpecs: "", stock: stock.totalStock || 0, bestPrice: stock.bestPrice || "", dkStock: stock.digikey ? stock.digikey.stock : 0, mousStock: stock.mouser ? stock.mouser.stock : 0, alt1: "", alt2: "", alt3: "" };

      // Get alternatives from AI
      try {
        var altRes = await callAI(ALT_SEARCH_SYSTEM, [{ role: "user", content: "Find alternatives for " + pn }], 2000);
        var altParsed = altRes.text ? extractJSON(altRes.text) : null;
        if (altParsed && altParsed.alternatives) {
          var alts = altParsed.alternatives.slice(0, 3);
          if (alts[0]) row.alt1 = alts[0].partNumber + " (" + alts[0].manufacturer + ")";
          if (alts[1]) row.alt2 = alts[1].partNumber + " (" + alts[1].manufacturer + ")";
          if (alts[2]) row.alt3 = alts[2].partNumber + " (" + alts[2].manufacturer + ")";
          if (alts[0] && alts[0].keySpecs) row.keySpecs = alts[0].keySpecs.map(function(s) { return s.label + "=" + s.value + s.unit; }).join("; ");
        }
      } catch (e) { console.error("Alt lookup failed for " + pn, e.message); }
      results.push(row);
    }

    var csvHeaders = ["Part Number","Description","Category","Key Specs","Total Stock","Best Price","Digi-Key Stock","Mouser Stock","Alternative 1","Alternative 2","Alternative 3"];
    var csvRows = results.map(function(r) { return [r.partNumber, r.description, r.category, r.keySpecs, r.stock, r.bestPrice, r.dkStock, r.mousStock, r.alt1, r.alt2, r.alt3]; });
    var csv = [csvHeaders].concat(csvRows).map(function(row) { return row.map(function(c) { return '"' + String(c || "").replace(/"/g, '""') + '"'; }).join(","); }).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=BOM_PartTensor.csv");
    res.send(csv);
  } catch (err) {
    console.error("Excel BOM error:", err.message);
    res.status(500).json({ error: "Failed to process file: " + err.message });
  }
});

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log("\nPartTensor backend running on port " + PORT);
  console.log("  GET  /api/health");
  console.log("  POST /api/chat");
  console.log("  POST /api/excel-bom\n");
});
