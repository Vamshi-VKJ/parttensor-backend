const express = require(“express”);
const cors = require(“cors”);
const multer = require(“multer”);
require(“dotenv”).config();

console.log(”=== PartTensor Backend Starting ===”);
console.log(“Anthropic key:”, process.env.ANTHROPIC_API_KEY ? “OK” : “MISSING”);
console.log(“DigiKey client ID:”, process.env.DIGIKEY_CLIENT_ID ? “OK” : “MISSING”);
console.log(“Mouser API key:”, process.env.MOUSER_API_KEY ? “OK” : “MISSING”);

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// =============================================
// CACHE
// =============================================
const aiCache = {};
const stockCache = {};
const AI_TTL = 24 * 60 * 60 * 1000;
const STOCK_TTL = 2 * 60 * 60 * 1000;

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
const fetch = (await import(“node-fetch”)).default;
try {
var res = await fetch(“https://api.digikey.com/v1/oauth2/token”, {
method: “POST”,
headers: { “Content-Type”: “application/x-www-form-urlencoded” },
body: new URLSearchParams({ grant_type: “client_credentials”, client_id: process.env.DIGIKEY_CLIENT_ID, client_secret: process.env.DIGIKEY_CLIENT_SECRET }),
});
var data = await res.json();
if (data.access_token) {
digikeyToken = data.access_token;
digikeyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
console.log(“DigiKey token refreshed”);
return digikeyToken;
}
console.error(“DigiKey token error:”, JSON.stringify(data));
return null;
} catch (e) { console.error(“DigiKey token failed:”, e.message); return null; }
}

// =============================================
// DIGIKEY LOOKUP
// =============================================
async function lookupDigikey(mpn) {
try {
const fetch = (await import(“node-fetch”)).default;
var token = await getDigikeyToken();
if (!token) return null;
var res = await fetch(
“https://api.digikey.com/products/v4/search/” + encodeURIComponent(mpn) + “/productdetails”,
{ method: “GET”, headers: { “Authorization”: “Bearer “ + token, “X-DIGIKEY-Client-Id”: process.env.DIGIKEY_CLIENT_ID, “X-DIGIKEY-Locale-Site”: “US”, “X-DIGIKEY-Locale-Language”: “en”, “X-DIGIKEY-Locale-Currency”: “USD” } }
);
if (res.ok) {
var data = await res.json();
var product = data.Product || data;
var unitPrice = product.UnitPrice || (product.StandardPricing && product.StandardPricing[0] && product.StandardPricing[0].UnitPrice) || null;
return { found: true, stock: product.QuantityAvailable || 0, price: unitPrice ? “$” + parseFloat(unitPrice).toFixed(3) : null, url: product.ProductUrl || “https://www.digikey.com/en/products/filter/” + encodeURIComponent(mpn), matchedPart: product.ManufacturerProductNumber || mpn };
}
var res2 = await fetch(“https://api.digikey.com/products/v4/search/keyword”, {
method: “POST”,
headers: { “Authorization”: “Bearer “ + token, “X-DIGIKEY-Client-Id”: process.env.DIGIKEY_CLIENT_ID, “X-DIGIKEY-Locale-Site”: “US”, “X-DIGIKEY-Locale-Language”: “en”, “X-DIGIKEY-Locale-Currency”: “USD”, “Content-Type”: “application/json” },
body: JSON.stringify({ Keywords: mpn, Limit: 5, Offset: 0, FilterOptionsRequest: { InStock: false } }),
});
if (!res2.ok) return null;
var data2 = await res2.json();
var products = data2.Products || [];
if (products.length === 0) return null;
var best = products.reduce(function(a, b) { return (b.QuantityAvailable || 0) > (a.QuantityAvailable || 0) ? b : a; });
var unitPrice2 = best.UnitPrice || (best.StandardPricing && best.StandardPricing[0] && best.StandardPricing[0].UnitPrice) || null;
return { found: true, stock: best.QuantityAvailable || 0, price: unitPrice2 ? “$” + parseFloat(unitPrice2).toFixed(3) : null, url: best.ProductUrl || “https://www.digikey.com/en/products/filter/” + encodeURIComponent(mpn), matchedPart: best.ManufacturerProductNumber || mpn };
} catch (e) { console.error(“DK lookup failed for “ + mpn + “:”, e.message); return null; }
}

// =============================================
// MOUSER LOOKUP
// =============================================
async function lookupMouser(mpn) {
try {
const fetch = (await import(“node-fetch”)).default;
var res = await fetch(“https://api.mouser.com/api/v1/search/partnumber?apiKey=” + process.env.MOUSER_API_KEY, {
method: “POST”, headers: { “Content-Type”: “application/json” },
body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: “Begins With” } }),
});
var data = res.ok ? await res.json() : null;
var parts = data && data.SearchResults && data.SearchResults.Parts || [];
if (parts.length === 0) {
var res2 = await fetch(“https://api.mouser.com/api/v1/search/keyword?apiKey=” + process.env.MOUSER_API_KEY, {
method: “POST”, headers: { “Content-Type”: “application/json” },
body: JSON.stringify({ SearchByKeywordRequest: { keyword: mpn, records: 5, startingRecord: 0, searchOptions: “BeginsWith” } }),
});
var data2 = res2.ok ? await res2.json() : null;
parts = data2 && data2.SearchResults && data2.SearchResults.Parts || [];
}
if (parts.length === 0) return null;
var best = parts.reduce(function(a, b) {
return (parseInt((b.Availability || “0”).replace(/[^0-9]/g, “”)) || 0) > (parseInt((a.Availability || “0”).replace(/[^0-9]/g, “”)) || 0) ? b : a;
});
var stock = parseInt((best.Availability || “0”).replace(/[^0-9]/g, “”)) || 0;
var price = best.PriceBreaks && best.PriceBreaks[0] && best.PriceBreaks[0].Price;
return { found: true, stock: stock, price: price || null, url: best.ProductDetailUrl || “https://www.mouser.com/Search/Refine?Keyword=” + encodeURIComponent(mpn), matchedPart: best.ManufacturerPartNumber || mpn };
} catch (e) { console.error(“Mouser lookup failed for “ + mpn + “:”, e.message); return null; }
}

// =============================================
// FETCH ORIGINAL PART SPECS FROM DIGIKEY
// =============================================
async function fetchOriginalPartSpecs(mpn) {
try {
const fetch = (await import(“node-fetch”)).default;
var token = await getDigikeyToken();
if (!token) return null;
var res = await fetch(
“https://api.digikey.com/products/v4/search/” + encodeURIComponent(mpn) + “/productdetails”,
{ method: “GET”, headers: { “Authorization”: “Bearer “ + token, “X-DIGIKEY-Client-Id”: process.env.DIGIKEY_CLIENT_ID, “X-DIGIKEY-Locale-Site”: “US”, “X-DIGIKEY-Locale-Language”: “en”, “X-DIGIKEY-Locale-Currency”: “USD” } }
);
var product = null;
if (res.ok) {
var data = await res.json();
product = data.Product || data;
} else {
var res2 = await fetch(“https://api.digikey.com/products/v4/search/keyword”, {
method: “POST”,
headers: { “Authorization”: “Bearer “ + token, “X-DIGIKEY-Client-Id”: process.env.DIGIKEY_CLIENT_ID, “X-DIGIKEY-Locale-Site”: “US”, “X-DIGIKEY-Locale-Language”: “en”, “X-DIGIKEY-Locale-Currency”: “USD”, “Content-Type”: “application/json” },
body: JSON.stringify({ Keywords: mpn, Limit: 3, Offset: 0 }),
});
if (!res2.ok) return null;
var data2 = await res2.json();
var prods = data2.Products || [];
if (prods.length === 0) return null;
product = prods[0];
}
if (!product) return null;
var parameters = product.Parameters || [];
var specs = {};
var specLines = [];
for (var i = 0; i < parameters.length; i++) {
var param = parameters[i];
var name = (param.Parameter || “”).toLowerCase();
var value = param.Value || “”;
specLines.push(param.Parameter + “: “ + value);
var numVal = parseFloat(value);
if ((name.includes(“voltage”) || name === “vds” || name === “vce”) && !isNaN(numVal) && !specs.voltage) specs.voltage = numVal;
if ((name.includes(“continuous”) && name.includes(“current”) || name === “id” || name === “ic”) && !isNaN(numVal) && !specs.current) specs.current = numVal;
if ((name.includes(“rds”) || name.includes(“resistance”)) && !isNaN(numVal) && !specs.resistance) specs.resistance = numVal;
if (name.includes(“power”) && name.includes(“dissipation”) && !isNaN(numVal) && !specs.power) specs.power = numVal;
}
var description = product.Description && product.Description.ProductDescription || “”;
var categoryName = product.Category && product.Category.Name || “”;
var isPassiveConnector = classifyComponent(description, categoryName) === “passive_connector”;
return {
mpn: product.ManufacturerProductNumber || mpn,
manufacturer: product.Manufacturer && product.Manufacturer.Name || “”,
description: description,
categoryName: categoryName,
isPassiveConnector: isPassiveConnector,
specs: specs,
specsText: specLines.slice(0, 15).join(”; “),
dkSearchUrl: “https://www.digikey.com/en/products/result?keywords=” + encodeURIComponent(description.split(/\s+/).slice(0, 5).join(” “)) + “&stock=1”,
mouserSearchUrl: “https://www.mouser.com/Search/Refine?Keyword=” + encodeURIComponent(mpn) + “&inStock=1”,
octopartUrl: “https://octopart.com/search?q=” + encodeURIComponent(mpn) + “&in_stock=1”,
};
} catch (e) { console.error(“fetchOriginalPartSpecs failed:”, e.message); return null; }
}

// =============================================
// COMPONENT CLASSIFIER
// =============================================
var PASSIVE_CONNECTOR_KEYWORDS = [“connector”, “receptacle”, “plug”, “socket”, “jack”, “header”, “terminal”, “contact”, “coax”, “coaxial”, “mmcx”, “sma”, “bnc”, “rj”, “usb “, “hdmi”, “resistor”, “capacitor”, “inductor”, “ferrite”, “crystal”, “resonator”, “transformer”, “relay”, “switch”, “fuse”, “varistor”, “thermistor”, “potentiometer”, “trimmer”, “antenna”, “filter”, “balun”, “rf “];
function classifyComponent(description, categoryName) {
var text = ((description || “”) + “ “ + (categoryName || “”)).toLowerCase();
for (var i = 0; i < PASSIVE_CONNECTOR_KEYWORDS.length; i++) {
if (text.indexOf(PASSIVE_CONNECTOR_KEYWORDS[i]) !== -1) return “passive_connector”;
}
return “semiconductor”;
}

// =============================================
// PREFETCH STOCK FOR PARTS
// =============================================
async function prefetchStock(partNumbers) {
var stockResults = {};
for (var i = 0; i < partNumbers.length; i++) {
var mpn = partNumbers[i];
if (!mpn) continue;
var cached = getCached(stockCache, mpn);
if (cached) { stockResults[mpn] = cached; continue; }
var results = await Promise.all([lookupDigikey(mpn), lookupMouser(mpn)]);
var dk = results[0], mouser = results[1];
var total = (dk ? dk.stock : 0) + (mouser ? mouser.stock : 0);
var bestPrice = null, bestPriceSource = null;
if (dk && dk.price) { bestPrice = dk.price; bestPriceSource = “Digi-Key”; }
if (mouser && mouser.price) {
var mv = parseFloat((mouser.price || “999”).replace(/[^0-9.]/g, “”)) || 999;
var cv = parseFloat((bestPrice || “999”).replace(/[^0-9.]/g, “”)) || 999;
if (mv < cv) { bestPrice = mouser.price; bestPriceSource = “Mouser”; }
}
var sr = {
found: total > 0, totalStock: total, bestPrice: bestPrice, bestPriceSource: bestPriceSource,
digikey: dk, mouser: mouser,
octopartUrl: “https://octopart.com/search?q=” + encodeURIComponent(mpn),
};
setCache(stockCache, mpn, sr, STOCK_TTL);
stockResults[mpn] = sr;
console.log(”  Stock”, mpn, “-> DK:”, dk ? dk.stock : “N/A”, “MO:”, mouser ? mouser.stock : “N/A”);
}
return stockResults;
}

// =============================================
// EXTRACT JSON HELPER
// =============================================
function extractJSON(text) {
var clean = text.replace(/`json/gi, "").replace(/`/g, “”).trim();
var depth = 0, start = -1, end = -1;
for (var i = 0; i < clean.length; i++) {
if (clean[i] === “{”) { if (depth === 0) start = i; depth++; }
else if (clean[i] === “}”) { depth–; if (depth === 0) { end = i; break; } }
}
if (start === -1 || end === -1) return null;
try { return JSON.parse(clean.substring(start, end + 1)); }
catch (e) { return null; }
}

// =============================================
// CALL AI WITH RETRY
// =============================================
async function callAI(system, messages, maxTokens) {
const fetch = (await import(“node-fetch”)).default;
var models = [“claude-sonnet-4-20250514”, “claude-haiku-4-5-20251001”];
for (var attempt = 1; attempt <= 3; attempt++) {
var model = attempt <= 2 ? models[0] : models[1];
try {
var aiRes = await fetch(“https://api.anthropic.com/v1/messages”, {
method: “POST”,
headers: { “Content-Type”: “application/json”, “x-api-key”: process.env.ANTHROPIC_API_KEY, “anthropic-version”: “2023-06-01” },
body: JSON.stringify({ model: model, max_tokens: maxTokens || 4000, system: system, messages: messages }),
});
var aiData = await aiRes.json();
if (aiData.error && aiData.error.type === “overloaded_error”) {
await new Promise(function(r) { setTimeout(r, attempt * 3000); });
continue;
}
if (aiData.error) return { error: aiData.error.message };
var text = (aiData.content || []).map(function(b) { return b.text || “”; }).join(””);
return { text: text };
} catch (err) {
if (attempt < 3) await new Promise(function(r) { setTimeout(r, 2000); });
}
}
return { error: “All retries failed.” };
}

// =============================================
// INTENT CLASSIFIER PROMPT
// =============================================
var INTENT_PROMPT = [
“You classify hardware engineering queries. Respond ONLY with JSON:”,
“{"intent": "part_search|find_alternatives|generate_bom|circuit_question|calculation|correction|general",”,
“ "partNumber": "extracted part number or null",”,
“ "needsMoreInfo": true/false,”,
“ "followUpQuestion": "question to ask user if more info needed, or null"}”,
“”,
“intent definitions:”,
“- part_search: user wants to find a component (MOSFET, op-amp, regulator, sensor etc)”,
“- find_alternatives: user wants alternatives/replacements for a specific part”,
“- generate_bom: user describes a system/application and wants a BOM”,
“- circuit_question: topology, design, how-to, theory, best approach”,
“- calculation: numerical calc — gate resistor, power dissipation, filter, etc”,
“- correction: user says previous result was wrong or wants to refine”,
“- general: general electronics question”,
“”,
“needsMoreInfo: true only if critical spec is missing AND question is ambiguous.”,
“If the user provides even basic info, set needsMoreInfo false and proceed.”,
].join(”\n”);

// =============================================
// ENGINEERING AI PROMPT
// =============================================
var ENGINEERING_PROMPT = [
“You are PartTensor — a senior hardware application engineer AI assistant.”,
“You help electronics engineers with:”,
“- Component selection (MOSFETs, ICs, passives, sensors, connectors)”,
“- Finding alternatives and cross-references”,
“- Generating Bills of Materials”,
“- Circuit design, topology selection, calculations”,
“- Troubleshooting”,
“”,
“STYLE:”,
“- Be direct and technical. Engineers appreciate precision.”,
“- Use real part numbers, real formulas, real specs.”,
“- For circuit questions: give practical answers with equations where relevant.”,
“- Format clearly: use **bold headers**, bullet points (- ), equations.”,
“- Do not be excessively verbose. Get to the point.”,
“- When suggesting parts mention manufacturer and why it’s a good choice.”,
“”,
“Do NOT respond with JSON. Respond with natural text.”,
].join(”\n”);

// =============================================
// PART SEARCH PROMPT
// =============================================
var SEARCH_PROMPT = [
“You are a senior application engineer finding electronic components.”,
“RULES:”,
“- Suggest EXACTLY 4 results from 4 DIFFERENT manufacturers”,
“- rank: first=top, second=good, third/fourth=alternative”,
“- ONLY parts that ACTUALLY EXIST on Digi-Key”,
“- From Infineon, Vishay, ON Semi, TI, STMicro, Analog Devices, Microchip, Renesas, Rohm, Nexperia”,
“- ALL parts must meet or EXCEED requested specifications”,
“- Include exactly 5 keySpecs per part with numeric values”,
“- First part must be the absolute best fit for the stated requirements”,
“”,
“Respond ONLY raw JSON starting with {:”,
“{"mode":"search","category":"N-Channel MOSFET","interpretation":"one sentence",”,
“"results":[{"partNumber":"IRF540NPBF","manufacturer":"Vishay","type":"N-Channel MOSFET",”,
“"keySpecs":[{"label":"VDS","value":"100","unit":"V"},{"label":"ID","value":"33","unit":"A"},”,
“{"label":"RDS(on)","value":"44","unit":"mΩ"},{"label":"Qg","value":"71","unit":"nC"},{"label":"Package","value":"TO-220","unit":""}],”,
“"package":"TO-220","applications":["Motor Drive"],"rank":"top","aeComment":"Best fit because…","caution":null}],”,
“"designTip":"one practical tip"}”,
].join(”\n”);

// =============================================
// BOM PROMPT
// =============================================
var BOM_PROMPT = [
“You are a senior hardware application engineer. Generate a smart Bill of Materials.”,
“RULES:”,
“- Only critical components: MOSFETs, ICs, drivers, specialized inductors, electrolytic caps,”,
“  current sense resistors, crystals, connectors, optocouplers, diodes, sensors”,
“- NO generic resistors, 100nF caps, generic LEDs”,
“- Use FULL part numbers exactly as on Digi-Key”,
“- Include 5 keySpecs per part with exact numeric values”,
“- Prioritize high-availability parts”,
“”,
“Respond ONLY raw JSON starting with {:”,
“{"bomItems":[{"id":1,"function":"Gate Driver","partNumber":"IR2184SPBF",”,
“"manufacturer":"Infineon","description":"one line","category":"IC",”,
“"quantity":1,"keySpecs":"600V 2A SO-8","package":"SO-8",”,
“"priority":"critical","unitPrice":"$1.20","notes":null}],”,
“"projectName":"name","description":"sentence","voltage":"V","power":"W",”,
“"designNotes":"notes","totalEstimate":"$15-25"}”,
].join(”\n”);

// =============================================
// ALT FINDER PROMPT BUILDER
// =============================================
function buildAltPrompt(originalPart) {
var specs = originalPart.specs || {};
var specLines = [];
if (specs.voltage) specLines.push(“Voltage >= “ + specs.voltage + “V”);
if (specs.current) specLines.push(“Current >= “ + specs.current + “A”);
if (specs.resistance) specLines.push(“Rds/Ron <= “ + specs.resistance);
if (specs.power) specLines.push(“Power >= “ + specs.power + “W”);
if (specLines.length === 0) specLines.push(“Match or exceed: “ + originalPart.specsText.substring(0, 200));
return [
“Find EXACTLY 4 alternatives from 4 DIFFERENT manufacturers for:”,
originalPart.mpn + “ by “ + originalPart.manufacturer + “ — “ + originalPart.description,
“”,
“REQUIRED SPECS (from DigiKey): “ + specLines.join(”, “),
“”,
“RULES:”,
“- All must meet or EXCEED every spec above”,
“- ONLY parts that ACTUALLY EXIST on Digi-Key”,
“- From different manufacturers than “ + originalPart.manufacturer,
“- Include exactly 5 keySpecs per part — first=voltage, second=current”,
“- Sort by best drop-in compatibility first”,
“”,
“Respond ONLY raw JSON starting with {:”,
“{"mode":"alt","originalPart":"” + originalPart.mpn + “",”,
“"originalSpecs":"” + specLines.join(”, “) + “",”,
“"alternatives":[{"partNumber":"IRFB4115GPBF","manufacturer":"Vishay",”,
“"type":"N-Channel MOSFET","compatibility":"drop-in",”,
“"keySpecs":[{"label":"VDS","value":"150","unit":"V"},”,
“{"label":"ID","value":"104","unit":"A"},{"label":"RDS(on)","value":"11","unit":"mΩ"},”,
“{"label":"Qg","value":"120","unit":"nC"},{"label":"Package","value":"TO-220","unit":""}],”,
“"package":"TO-220","whyAlternative":"reason","differences":"differences"}],”,
“"importantNote":"note"}”,
].join(”\n”);
}

// =============================================
// EXTRACT PART NUMBER FROM TEXT
// =============================================
function extractPartNumber(text) {
var m1 = text.match(/\b([A-Z]{1,6}[0-9]{2,}[A-Z0-9-]*)\b/gi) || [];
var m2 = text.match(/\b([0-9]+[-][0-9A-Z][-0-9A-Z]*)\b/gi) || [];
var m3 = text.match(/\b([0-9]{7,})\b/gi) || [];
var all = m1.concat(m2).concat(m3).filter(function(m) { return m.length >= 4; });
if (all.length === 0) return null;
return all.sort(function(a, b) { return b.length - a.length; })[0];
}

// =============================================
// HEALTH ENDPOINT
// =============================================
app.get(”/api/health”, function(req, res) {
res.json({ status: “ok”, service: “PartTensor”, time: new Date().toISOString() });
});

// =============================================
// MAIN CHAT ENDPOINT
// Single endpoint that handles everything
// =============================================
app.post(”/api/chat”, async function(req, res) {
try {
var message = req.body.message;
var history = req.body.history || [];
var isCorrection = req.body.isCorrection || false;

```
if (!message) return res.status(400).json({ error: "Message is required" });

console.log("\n[CHAT]", message.substring(0, 80));

// =============================================
// STEP 1: CLASSIFY INTENT
// =============================================
var intentMessages = [{ role: "user", content: message }];
if (history.length > 0) {
  var recent = history.slice(-4);
  intentMessages = recent.concat([{ role: "user", content: message }]);
}
if (isCorrection) {
  intentMessages[intentMessages.length - 1].content = "[CORRECTION] " + message;
}

var intentResult = await callAI(INTENT_PROMPT, [{ role: "user", content: JSON.stringify({ message: message, historyLength: history.length, isCorrection: isCorrection }) }], 200);
var intent = "part_search";
var needsMoreInfo = false;
var followUpQuestion = null;
var detectedPartNumber = null;

if (intentResult.text) {
  var parsed = extractJSON(intentResult.text);
  if (parsed) {
    intent = parsed.intent || "part_search";
    needsMoreInfo = parsed.needsMoreInfo || false;
    followUpQuestion = parsed.followUpQuestion || null;
    detectedPartNumber = parsed.partNumber || null;
  }
}

console.log("Intent:", intent, "| PN:", detectedPartNumber, "| NeedsMore:", needsMoreInfo);

// =============================================
// STEP 2: IF NEEDS MORE INFO - ASK QUESTION
// =============================================
if (needsMoreInfo && followUpQuestion && !isCorrection) {
  return res.json({
    text: followUpQuestion,
    intent: intent,
    mode: "question",
  });
}

// =============================================
// STEP 3: ROUTE TO HANDLER
// =============================================

// Build full message array with history for context
var fullMessages = [];
for (var i = 0; i < Math.min(history.length, 8); i++) {
  fullMessages.push({ role: history[i].role, content: history[i].content || "" });
}
fullMessages.push({ role: "user", content: message });

// --- CIRCUIT QUESTION / CALCULATION / GENERAL ---
if (intent === "circuit_question" || intent === "calculation" || intent === "general") {
  var aiResult = await callAI(ENGINEERING_PROMPT, fullMessages, 2000);
  if (aiResult.error) return res.status(503).json({ error: aiResult.error });
  return res.json({ text: aiResult.text, intent: intent, mode: "text" });
}

// --- CORRECTION ---
if (intent === "correction") {
  var correctionResult = await callAI(ENGINEERING_PROMPT + "\n\nThe user is correcting or refining a previous response. Address their feedback directly.", fullMessages, 3000);
  if (correctionResult.error) return res.status(503).json({ error: correctionResult.error });
  // Also try to re-run the original query with corrections
  return res.json({ text: correctionResult.text, intent: intent, mode: "text" });
}

// --- FIND ALTERNATIVES ---
if (intent === "find_alternatives") {
  var pn = detectedPartNumber || extractPartNumber(message);
  if (!pn) {
    return res.json({ text: "Could you specify the part number you want alternatives for?", intent: intent, mode: "question" });
  }

  // Fetch real specs from DigiKey first
  console.log("Fetching specs for:", pn);
  var originalPart = await fetchOriginalPartSpecs(pn);

  if (!originalPart) {
    // Fall back to AI-only approach
    var altMessages = [{ role: "user", content: "Find alternatives for " + pn }];
    var altAI = await callAI(SEARCH_PROMPT.replace("EXACTLY 4 results", "EXACTLY 4 alternatives").replace("\"mode\":\"search\"", "\"mode\":\"alt\""), altMessages, 4000);
    var altParsed = altAI.text ? extractJSON(altAI.text) : null;
    if (!altParsed) return res.json({ text: "I couldn't find detailed specs for " + pn + ". Could you provide the key specs you need to match?", intent: intent, mode: "question" });
    var altParts = altParsed.alternatives || altParsed.results || [];
    var altStock = await prefetchStock(altParts.map(function(p) { return p.partNumber; }));
    altParsed.stockData = altStock;
    return res.json(Object.assign({ text: "Here are alternatives for **" + pn + "**:", intent: intent }, altParsed));
  }

  if (originalPart.isPassiveConnector) {
    var passiveText = "For **" + pn + "** (" + originalPart.categoryName + "), I recommend using parametric search to find the best alternative — it ensures you match all the critical specs exactly.";
    return res.json({
      text: passiveText,
      mode: "passive_connector_alt",
      originalPart: pn,
      originalManufacturer: originalPart.manufacturer,
      originalDescription: originalPart.description,
      categoryName: originalPart.categoryName,
      searchLinks: [
        { name: "🔵 Search Digi-Key", url: originalPart.dkSearchUrl, description: "Filter by specs in parametric search" },
        { name: "🟣 Search Mouser", url: originalPart.mouserSearchUrl, description: "Find in-stock alternatives on Mouser" },
        { name: "🔍 Search Octopart", url: originalPart.octopartUrl, description: "Compare across all distributors" },
      ],
      tips: ["Category: " + originalPart.categoryName, originalPart.specsText.substring(0, 150)],
      intent: intent,
    });
  }

  // Semiconductor — AI with real specs
  var altPrompt = buildAltPrompt(originalPart);
  var altResult = await callAI(altPrompt, [{ role: "user", content: message }], 4000);
  var altData = altResult.text ? extractJSON(altResult.text) : null;
  if (!altData) return res.json({ text: "I had trouble finding alternatives for " + pn + ". Please try again.", intent: intent, mode: "text" });

  var altParts2 = altData.alternatives || [];
  var altStock2 = await prefetchStock(altParts2.map(function(p) { return p.partNumber; }));
  altData.stockData = altStock2;

  return res.json(Object.assign({
    text: "Here are **" + altParts2.length + " alternatives** for **" + pn + "**, all meeting or exceeding its specs:",
    intent: intent,
  }, altData));
}

// --- GENERATE BOM ---
if (intent === "generate_bom") {
  var cacheKey = "bom:" + message.toLowerCase().trim();
  var cachedBOM = getCached(aiCache, cacheKey);
  if (cachedBOM) {
    console.log("BOM cache hit");
    return res.json(cachedBOM);
  }

  var bomResult = await callAI(BOM_PROMPT, [{ role: "user", content: message }], 4000);
  var bomData = bomResult.text ? extractJSON(bomResult.text) : null;
  if (!bomData || !bomData.bomItems) {
    return res.json({ text: "I had trouble generating the BOM. Could you describe the application in more detail?", intent: intent, mode: "question" });
  }

  var bomParts = bomData.bomItems.map(function(p) { return p.partNumber; });
  var bomStock = await prefetchStock(bomParts);
  bomData.stockData = bomStock;

  var bomSummary = "Here's a **sourcing-ready BOM** for your **" + bomData.projectName + "** — " + bomData.bomItems.length + " critical components, verified on Digi-Key:";
  var result = Object.assign({ text: bomSummary, intent: intent }, bomData);

  setCache(aiCache, cacheKey, result, AI_TTL);
  return res.json(result);
}

// --- PART SEARCH (default) ---
var searchCacheKey = "search:" + message.toLowerCase().trim();
var cachedSearch = getCached(aiCache, searchCacheKey);
if (cachedSearch) {
  console.log("Search cache hit");
  return res.json(cachedSearch);
}

var searchResult = await callAI(SEARCH_PROMPT, [{ role: "user", content: message }], 4000);
var searchData = searchResult.text ? extractJSON(searchResult.text) : null;

if (!searchData || !searchData.results) {
  // Fall back to general engineering response
  var fallback = await callAI(ENGINEERING_PROMPT, fullMessages, 1500);
  return res.json({ text: fallback.text || "I couldn't find specific parts for that query. Could you provide more details about the specs you need?", intent: intent, mode: "text" });
}

var searchParts = searchData.results.map(function(p) { return p.partNumber; });
var searchStock = await prefetchStock(searchParts);
searchData.stockData = searchStock;

// Sort by stock
searchData.results = searchData.results.slice().sort(function(a, b) {
  var sa = searchStock[a.partNumber] ? searchStock[a.partNumber].totalStock : 0;
  var sb = searchStock[b.partNumber] ? searchStock[b.partNumber].totalStock : 0;
  return sb - sa;
});

var searchText = "Found **" + searchData.results.length + " options** for " + searchData.interpretation + ". Sorted by stock availability:";
var searchResponse = Object.assign({ text: searchText, intent: intent }, searchData);

setCache(aiCache, searchCacheKey, searchResponse, AI_TTL);
return res.json(searchResponse);
```

} catch (err) {
console.error(“Chat route error:”, err.message, err.stack);
res.status(500).json({ error: “Something went wrong: “ + err.message });
}
});

// =============================================
// EXCEL BOM UPLOAD ENDPOINT
// =============================================
app.post(”/api/excel-bom”, upload.single(“file”), async function(req, res) {
try {
if (!req.file) return res.status(400).json({ error: “No file uploaded” });

```
console.log("\n[EXCEL BOM] Processing:", req.file.originalname, req.file.size + " bytes");

// Parse CSV or use AI to extract part numbers
var fileContent = req.file.buffer.toString("utf8");
var isCSV = req.file.originalname.endsWith(".csv") || req.file.mimetype === "text/csv";

var partNumbers = [];

if (isCSV) {
  // Parse CSV to find part number column
  var lines = fileContent.split("\n").filter(function(l) { return l.trim(); });
  if (lines.length === 0) return res.status(400).json({ error: "Empty file" });

  var headers = lines[0].split(",").map(function(h) { return h.replace(/"/g, "").trim().toLowerCase(); });
  var pnColIdx = -1;
  var pnKeywords = ["part number", "pn", "mpn", "part no", "partno", "part#", "component", "part_number", "manufacturer part"];
  for (var ki = 0; ki < pnKeywords.length; ki++) {
    for (var hi = 0; hi < headers.length; hi++) {
      if (headers[hi].includes(pnKeywords[ki])) { pnColIdx = hi; break; }
    }
    if (pnColIdx >= 0) break;
  }
  if (pnColIdx < 0) pnColIdx = 0; // default to first column

  for (var li = 1; li < lines.length; li++) {
    var cols = lines[li].split(",").map(function(c) { return c.replace(/"/g, "").trim(); });
    if (cols[pnColIdx]) partNumbers.push(cols[pnColIdx]);
  }
} else {
  // For xlsx: extract text and use AI to identify part numbers
  var aiExtract = await callAI(
    "Extract all electronic part numbers from this BOM data. Return ONLY a JSON array of part number strings. No explanation.",
    [{ role: "user", content: "BOM data (first 3000 chars):\n" + fileContent.substring(0, 3000) }],
    500
  );
  if (aiExtract.text) {
    try {
      var clean = aiExtract.text.replace(/```json/gi, "").replace(/```/g, "").trim();
      var start = clean.indexOf("["), end = clean.lastIndexOf("]");
      if (start >= 0 && end >= 0) partNumbers = JSON.parse(clean.substring(start, end + 1));
    } catch (e) {}
  }
}

if (partNumbers.length === 0) return res.status(400).json({ error: "No part numbers found. Make sure your file has a 'Part Number' column." });

console.log("Found", partNumbers.length, "parts:", partNumbers.slice(0, 5).join(", "), "...");

// For each part: fetch stock + find alternatives
var results = [];
var processLimit = Math.min(partNumbers.length, 20); // limit to 20 parts

for (var pi = 0; pi < processLimit; pi++) {
  var pn = partNumbers[pi];
  if (!pn) continue;
  var stockData = await prefetchStock([pn]);
  var stock = stockData[pn] || {};

  // Get alternatives
  var altRow = { partNumber: pn, stock: stock.totalStock || 0, bestPrice: stock.bestPrice || "", dkStock: stock.digikey ? stock.digikey.stock : 0, mousStock: stock.mouser ? stock.mouser.stock : 0, alt1: "", alt2: "", alt3: "" };

  try {
    var originalPart = await fetchOriginalPartSpecs(pn);
    if (originalPart && !originalPart.isPassiveConnector) {
      var altPrompt2 = buildAltPrompt(originalPart);
      var altAIResult = await callAI(altPrompt2, [{ role: "user", content: "Find alternatives for " + pn }], 3000);
      var altParsed2 = altAIResult.text ? extractJSON(altAIResult.text) : null;
      if (altParsed2 && altParsed2.alternatives) {
        var alts = altParsed2.alternatives.slice(0, 3);
        altRow.alt1 = alts[0] ? alts[0].partNumber + " (" + alts[0].manufacturer + ", " + alts[0].compatibility + ")" : "";
        altRow.alt2 = alts[1] ? alts[1].partNumber + " (" + alts[1].manufacturer + ")" : "";
        altRow.alt3 = alts[2] ? alts[2].partNumber + " (" + alts[2].manufacturer + ")" : "";
        if (originalPart) {
          altRow.description = originalPart.description;
          altRow.category = originalPart.categoryName;
          altRow.keySpecs = originalPart.specsText.substring(0, 100);
        }
      }
    }
  } catch (e) { console.error("Alt lookup failed for " + pn + ":", e.message); }

  results.push(altRow);
}

// Build output CSV
var csvHeaders = ["Part Number", "Description", "Category", "Key Specs", "Total Stock", "Best Price", "Digi-Key Stock", "Mouser Stock", "Alternative 1", "Alternative 2", "Alternative 3"];
var csvRows = results.map(function(r) {
  return [r.partNumber, r.description || "", r.category || "", r.keySpecs || "", r.stock, r.bestPrice, r.dkStock, r.mousStock, r.alt1, r.alt2, r.alt3];
});
var csv = [csvHeaders].concat(csvRows).map(function(row) {
  return row.map(function(c) { return '"' + String(c || "").replace(/"/g, '""') + '"'; }).join(",");
}).join("\n");

var fileName = (req.file.originalname || "bom").replace(/\.[^.]+$/, "") + "_PartTensor.csv";
res.setHeader("Content-Type", "text/csv");
res.setHeader("Content-Disposition", "attachment; filename=" + fileName);
res.send(csv);
```

} catch (err) {
console.error(“Excel BOM error:”, err.message);
res.status(500).json({ error: “Failed to process file: “ + err.message });
}
});

// =============================================
// START SERVER
// =============================================
var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
console.log(”\nPartTensor backend running on http://localhost:” + PORT);
console.log(”  GET  /api/health”);
console.log(”  POST /api/chat     — unified chat endpoint”);
console.log(”  POST /api/excel-bom — Excel BOM upload\n”);
});