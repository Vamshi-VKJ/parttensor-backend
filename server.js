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

// =============================================
// CACHE
// =============================================
var aiCache = {};
var stockCache = {};
var AI_TTL = 24 * 60 * 60 * 1000;
var STOCK_TTL = 2 * 60 * 60 * 1000;

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
// DIGIKEY LOOKUP
// =============================================
async function lookupDigikey(mpn) {
  try {
    var fetch = (await import("node-fetch")).default;
    var token = await getDigikeyToken();
    if (!token) return null;

    var res = await fetch(
      "https://api.digikey.com/products/v4/search/" + encodeURIComponent(mpn) + "/productdetails",
      {
        method: "GET",
        headers: {
          "Authorization": "Bearer " + token,
          "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID,
          "X-DIGIKEY-Locale-Site": "US",
          "X-DIGIKEY-Locale-Language": "en",
          "X-DIGIKEY-Locale-Currency": "USD",
        },
      }
    );

    if (res.ok) {
      var data = await res.json();
      var product = data.Product || data;
      var unitPrice = product.UnitPrice || (product.StandardPricing && product.StandardPricing[0] && product.StandardPricing[0].UnitPrice) || null;
      return {
        found: true,
        stock: product.QuantityAvailable || 0,
        price: unitPrice ? "$" + parseFloat(unitPrice).toFixed(3) : null,
        url: product.ProductUrl || "https://www.digikey.com/en/products/filter/" + encodeURIComponent(mpn),
        matchedPart: product.ManufacturerProductNumber || mpn,
      };
    }

    var res2 = await fetch("https://api.digikey.com/products/v4/search/keyword", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID,
        "X-DIGIKEY-Locale-Site": "US",
        "X-DIGIKEY-Locale-Language": "en",
        "X-DIGIKEY-Locale-Currency": "USD",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ Keywords: mpn, Limit: 5, Offset: 0 }),
    });
    if (!res2.ok) return null;
    var data2 = await res2.json();
    var products = data2.Products || [];
    if (products.length === 0) return null;
    var best = products.reduce(function(a, b) {
      return (b.QuantityAvailable || 0) > (a.QuantityAvailable || 0) ? b : a;
    });
    var unitPrice2 = best.UnitPrice || (best.StandardPricing && best.StandardPricing[0] && best.StandardPricing[0].UnitPrice) || null;
    return {
      found: true,
      stock: best.QuantityAvailable || 0,
      price: unitPrice2 ? "$" + parseFloat(unitPrice2).toFixed(3) : null,
      url: best.ProductUrl || "https://www.digikey.com/en/products/filter/" + encodeURIComponent(mpn),
      matchedPart: best.ManufacturerProductNumber || mpn,
    };
  } catch (e) {
    console.error("DK lookup failed for " + mpn + ":", e.message);
    return null;
  }
}

// =============================================
// MOUSER LOOKUP
// =============================================
async function lookupMouser(mpn) {
  try {
    var fetch = (await import("node-fetch")).default;
    var res = await fetch("https://api.mouser.com/api/v1/search/partnumber?apiKey=" + process.env.MOUSER_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: "Begins With" } }),
    });
    var data = res.ok ? await res.json() : null;
    var parts = (data && data.SearchResults && data.SearchResults.Parts) || [];

    if (parts.length === 0) {
      var res2 = await fetch("https://api.mouser.com/api/v1/search/keyword?apiKey=" + process.env.MOUSER_API_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ SearchByKeywordRequest: { keyword: mpn, records: 5, startingRecord: 0, searchOptions: "BeginsWith" } }),
      });
      var data2 = res2.ok ? await res2.json() : null;
      parts = (data2 && data2.SearchResults && data2.SearchResults.Parts) || [];
    }
    if (parts.length === 0) return null;

    var best = parts.reduce(function(a, b) {
      var as = parseInt((a.Availability || "0").replace(/[^0-9]/g, "")) || 0;
      var bs = parseInt((b.Availability || "0").replace(/[^0-9]/g, "")) || 0;
      return bs > as ? b : a;
    });
    var stock = parseInt((best.Availability || "0").replace(/[^0-9]/g, "")) || 0;
    var price = best.PriceBreaks && best.PriceBreaks[0] && best.PriceBreaks[0].Price;
    return {
      found: true,
      stock: stock,
      price: price || null,
      url: best.ProductDetailUrl || "https://www.mouser.com/Search/Refine?Keyword=" + encodeURIComponent(mpn),
      matchedPart: best.ManufacturerPartNumber || mpn,
    };
  } catch (e) {
    console.error("Mouser lookup failed for " + mpn + ":", e.message);
    return null;
  }
}

// =============================================
// PREFETCH STOCK
// =============================================
async function prefetchStock(partNumbers) {
  var stockResults = {};
  for (var i = 0; i < partNumbers.length; i++) {
    var mpn = partNumbers[i];
    if (!mpn) continue;
    var cached = getCached(stockCache, mpn);
    if (cached) { stockResults[mpn] = cached; continue; }
    var results = await Promise.all([lookupDigikey(mpn), lookupMouser(mpn)]);
    var dk = results[0];
    var mouser = results[1];
    var total = (dk ? dk.stock : 0) + (mouser ? mouser.stock : 0);
    var bestPrice = null;
    var bestPriceSource = null;
    if (dk && dk.price) { bestPrice = dk.price; bestPriceSource = "Digi-Key"; }
    if (mouser && mouser.price) {
      var mv = parseFloat((mouser.price || "999").replace(/[^0-9.]/g, "")) || 999;
      var cv = parseFloat((bestPrice || "999").replace(/[^0-9.]/g, "")) || 999;
      if (mv < cv) { bestPrice = mouser.price; bestPriceSource = "Mouser"; }
    }
    var sr = {
      found: total > 0,
      totalStock: total,
      bestPrice: bestPrice,
      bestPriceSource: bestPriceSource,
      digikey: dk,
      mouser: mouser,
      octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(mpn),
    };
    setCache(stockCache, mpn, sr, STOCK_TTL);
    stockResults[mpn] = sr;
    console.log("  Stock", mpn, "DK:", dk ? dk.stock : "N/A", "MO:", mouser ? mouser.stock : "N/A");
  }
  return stockResults;
}

// =============================================
// FETCH PART SPECS FROM DIGIKEY
// =============================================
var PASSIVE_KEYWORDS = ["connector","receptacle","plug","socket","jack","header","terminal","coax","mmcx","sma","bnc","usb ","hdmi","resistor","capacitor","inductor","ferrite","crystal","resonator","transformer","relay","switch","fuse","varistor","thermistor","potentiometer","antenna","filter","balun"];

function isPassiveConnector(description, categoryName) {
  var text = ((description || "") + " " + (categoryName || "")).toLowerCase();
  for (var i = 0; i < PASSIVE_KEYWORDS.length; i++) {
    if (text.indexOf(PASSIVE_KEYWORDS[i]) !== -1) return true;
  }
  return false;
}

async function fetchPartSpecs(mpn) {
  try {
    var fetch = (await import("node-fetch")).default;
    var token = await getDigikeyToken();
    if (!token) return null;

    var res = await fetch(
      "https://api.digikey.com/products/v4/search/" + encodeURIComponent(mpn) + "/productdetails",
      {
        method: "GET",
        headers: {
          "Authorization": "Bearer " + token,
          "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID,
          "X-DIGIKEY-Locale-Site": "US",
          "X-DIGIKEY-Locale-Language": "en",
          "X-DIGIKEY-Locale-Currency": "USD",
        },
      }
    );

    var product = null;
    if (res.ok) {
      var data = await res.json();
      product = data.Product || data;
    } else {
      var res2 = await fetch("https://api.digikey.com/products/v4/search/keyword", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID,
          "X-DIGIKEY-Locale-Site": "US",
          "X-DIGIKEY-Locale-Language": "en",
          "X-DIGIKEY-Locale-Currency": "USD",
          "Content-Type": "application/json",
        },
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
      var name = (param.Parameter || "").toLowerCase();
      var value = param.Value || "";
      specLines.push(param.Parameter + ": " + value);
      var numVal = parseFloat(value);
      if ((name.includes("voltage") || name === "vds" || name === "vce") && !isNaN(numVal) && !specs.voltage) specs.voltage = numVal;
      if ((name.includes("continuous") && name.includes("current") || name === "id" || name === "ic") && !isNaN(numVal) && !specs.current) specs.current = numVal;
      if ((name.includes("rds") || name.includes("resistance")) && !isNaN(numVal) && !specs.resistance) specs.resistance = numVal;
      if (name.includes("power") && name.includes("dissipation") && !isNaN(numVal) && !specs.power) specs.power = numVal;
    }

    var description = (product.Description && product.Description.ProductDescription) || "";
    var categoryName = (product.Category && product.Category.Name) || "";
    var searchKeyword = description.replace(/[^a-zA-Z0-9\s]/g, " ").split(/\s+/).filter(function(w) { return w.length > 2; }).slice(0, 5).join(" ");

    return {
      mpn: product.ManufacturerProductNumber || mpn,
      manufacturer: (product.Manufacturer && product.Manufacturer.Name) || "",
      description: description,
      categoryName: categoryName,
      isPassive: isPassiveConnector(description, categoryName),
      specs: specs,
      specsText: specLines.slice(0, 15).join("; "),
      dkSearchUrl: "https://www.digikey.com/en/products/result?keywords=" + encodeURIComponent(searchKeyword) + "&stock=1",
      mouserSearchUrl: "https://www.mouser.com/Search/Refine?Keyword=" + encodeURIComponent(mpn) + "&inStock=1",
      octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(mpn) + "&in_stock=1",
    };
  } catch (e) {
    console.error("fetchPartSpecs failed for " + mpn + ":", e.message);
    return null;
  }
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
  try { return JSON.parse(clean.substring(start, end + 1)); }
  catch (e) { return null; }
}

// =============================================
// EXTRACT PART NUMBER FROM TEXT
// =============================================
function extractPartNumber(text) {
  var m1 = text.match(/\b([A-Z]{1,6}[0-9]{2,}[A-Z0-9\-]*)\b/gi) || [];
  var m2 = text.match(/\b([0-9]+[\-][0-9A-Z][\-0-9A-Z]*)\b/gi) || [];
  var all = m1.concat(m2).filter(function(m) { return m.length >= 4; });
  if (all.length === 0) return null;
  return all.sort(function(a, b) { return b.length - a.length; })[0];
}

// =============================================
// CALL AI WITH RETRY
// =============================================
async function callAI(system, messages, maxTokens) {
  var fetch = (await import("node-fetch")).default;
  var models = ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"];
  for (var attempt = 1; attempt <= 3; attempt++) {
    var model = attempt <= 2 ? models[0] : models[1];
    try {
      var aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model,
          max_tokens: maxTokens || 3000,
          system: system,
          messages: messages,
        }),
      });
      var aiData = await aiRes.json();
      if (aiData.error && aiData.error.type === "overloaded_error") {
        await new Promise(function(r) { setTimeout(r, attempt * 3000); });
        continue;
      }
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
var INTENT_SYSTEM = "You classify hardware engineering queries. Respond ONLY with JSON, no other text:\n{\"intent\":\"part_search|find_alternatives|generate_bom|circuit_question|calculation|correction|general\",\"partNumber\":\"extracted part number or null\",\"needsMoreInfo\":false,\"followUpQuestion\":null}\nintent rules: part_search=finding a component, find_alternatives=replacement for specific part, generate_bom=system description needs BOM, circuit_question=design/topology/theory, calculation=numerical calculation, correction=user fixing previous answer, general=other electronics question. Set needsMoreInfo true ONLY if absolutely critical info is missing.";

var ENGINEERING_SYSTEM = "You are PartTensor, a senior hardware application engineer AI. Help engineers with component selection, circuit design, calculations, and troubleshooting. Be direct, technical and precise. Use real part numbers and formulas. Format with **bold headers** and - bullet points where helpful. Keep answers focused and practical.";

var SEARCH_SYSTEM = "You are a senior application engineer finding electronic components. Suggest EXACTLY 4 results from 4 DIFFERENT manufacturers. rank: first=top, second=good, third/fourth=alternative. First result must be absolute best fit. ALL parts must meet or exceed requested specs. Include exactly 5 keySpecs per part with numeric values. Use real Digi-Key part numbers only. Manufacturers: Infineon, Vishay, ON Semi, TI, STMicro, Analog Devices, Microchip, Renesas, Rohm, Nexperia.\nRespond ONLY with raw JSON starting with {:\n{\"mode\":\"search\",\"category\":\"N-Channel MOSFET\",\"interpretation\":\"one sentence\",\"results\":[{\"partNumber\":\"IRF540NPBF\",\"manufacturer\":\"Vishay\",\"type\":\"N-Channel MOSFET\",\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"100\",\"unit\":\"V\"},{\"label\":\"ID\",\"value\":\"33\",\"unit\":\"A\"},{\"label\":\"RDS(on)\",\"value\":\"44\",\"unit\":\"m\\u03a9\"},{\"label\":\"Qg\",\"value\":\"71\",\"unit\":\"nC\"},{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],\"package\":\"TO-220\",\"applications\":[\"Motor Drive\"],\"rank\":\"top\",\"aeComment\":\"Best fit because...\",\"caution\":null}],\"designTip\":\"one practical tip\"}";

var BOM_SYSTEM = "You are a senior hardware application engineer. Generate a smart Bill of Materials. Include only critical components: MOSFETs, ICs, drivers, specialized inductors, electrolytic caps, current sense resistors, crystals, connectors, optocouplers, diodes, sensors. NO generic resistors, 100nF caps, generic LEDs. Use full Digi-Key part numbers. Include 5 keySpecs per part.\nRespond ONLY with raw JSON starting with {:\n{\"bomItems\":[{\"id\":1,\"function\":\"Gate Driver\",\"partNumber\":\"IR2184SPBF\",\"manufacturer\":\"Infineon\",\"description\":\"one line\",\"category\":\"IC\",\"quantity\":1,\"keySpecs\":\"600V 2A SO-8\",\"package\":\"SO-8\",\"priority\":\"critical\",\"unitPrice\":\"$1.20\",\"notes\":null}],\"projectName\":\"name\",\"description\":\"sentence\",\"voltage\":\"V\",\"power\":\"W\",\"designNotes\":\"notes\",\"totalEstimate\":\"$15-25\"}";

function buildAltSystem(originalPart) {
  var specs = originalPart.specs || {};
  var specLines = [];
  if (specs.voltage) specLines.push("Voltage >= " + specs.voltage + "V");
  if (specs.current) specLines.push("Current >= " + specs.current + "A");
  if (specs.resistance) specLines.push("Rds/Ron <= " + specs.resistance);
  if (specs.power) specLines.push("Power >= " + specs.power + "W");
  if (specLines.length === 0) specLines.push("Match: " + originalPart.specsText.substring(0, 150));
  return "Find EXACTLY 4 alternatives from 4 DIFFERENT manufacturers for: " + originalPart.mpn + " by " + originalPart.manufacturer + " — " + originalPart.description + "\nREQUIRED SPECS (from DigiKey real data): " + specLines.join(", ") + "\nAll must meet or EXCEED every spec. Real Digi-Key parts only. Different manufacturers than " + originalPart.manufacturer + ". Sort by best drop-in compatibility first. Include exactly 5 keySpecs per part.\nRespond ONLY with raw JSON starting with {:\n{\"mode\":\"alt\",\"originalPart\":\"" + originalPart.mpn + "\",\"originalSpecs\":\"" + specLines.join(", ") + "\",\"alternatives\":[{\"partNumber\":\"IRFB4115GPBF\",\"manufacturer\":\"Vishay\",\"type\":\"N-Channel MOSFET\",\"compatibility\":\"drop-in\",\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"150\",\"unit\":\"V\"},{\"label\":\"ID\",\"value\":\"104\",\"unit\":\"A\"},{\"label\":\"RDS(on)\",\"value\":\"11\",\"unit\":\"m\\u03a9\"},{\"label\":\"Qg\",\"value\":\"120\",\"unit\":\"nC\"},{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],\"package\":\"TO-220\",\"whyAlternative\":\"reason\",\"differences\":\"key differences\"}],\"importantNote\":\"note\"}";
}

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

    // STEP 1: CLASSIFY INTENT
    var contextSummary = history.slice(-4).map(function(m) { return m.role + ": " + (m.content || "").substring(0, 100); }).join("\n");
    var intentInput = "Recent conversation:\n" + contextSummary + "\n\nNew message: " + message;
    var intentResult = await callAI(INTENT_SYSTEM, [{ role: "user", content: intentInput }], 200);
    var intent = "part_search";
    var needsMoreInfo = false;
    var followUpQuestion = null;
    var detectedPN = null;

    if (intentResult.text) {
      var intentParsed = extractJSON(intentResult.text);
      if (intentParsed) {
        intent = intentParsed.intent || "part_search";
        needsMoreInfo = intentParsed.needsMoreInfo || false;
        followUpQuestion = intentParsed.followUpQuestion || null;
        detectedPN = intentParsed.partNumber || null;
      }
    }
    console.log("Intent:", intent, "| PN:", detectedPN);

    // STEP 2: ASK FOLLOW-UP IF NEEDED
    if (needsMoreInfo && followUpQuestion && !isCorrection) {
      return res.json({ text: followUpQuestion, intent: intent, mode: "question" });
    }

    // Build message array with history
    var fullMessages = [];
    var historySlice = history.slice(-8);
    for (var i = 0; i < historySlice.length; i++) {
      if (historySlice[i].content) fullMessages.push({ role: historySlice[i].role, content: historySlice[i].content });
    }
    fullMessages.push({ role: "user", content: message });

    // STEP 3: ROUTE BY INTENT

    // CIRCUIT / CALCULATION / GENERAL / CORRECTION
    if (intent === "circuit_question" || intent === "calculation" || intent === "general" || intent === "correction") {
      var engSystem = ENGINEERING_SYSTEM;
      if (isCorrection) engSystem += "\n\nThe user is correcting a previous response. Address their feedback directly and provide improved answer.";
      var engResult = await callAI(engSystem, fullMessages, 2000);
      if (engResult.error) return res.status(503).json({ error: engResult.error });
      return res.json({ text: engResult.text, intent: intent, mode: "text" });
    }

    // FIND ALTERNATIVES
    if (intent === "find_alternatives") {
      var pn = detectedPN || extractPartNumber(message);
      if (!pn) {
        return res.json({ text: "Could you specify the part number you want alternatives for?", intent: intent, mode: "question" });
      }

      console.log("Fetching specs for:", pn);
      var originalPart = await fetchPartSpecs(pn);

      if (!originalPart) {
        var fallbackAlt = await callAI(SEARCH_SYSTEM, [{ role: "user", content: "Find alternatives for " + pn }], 3000);
        var fallbackParsed = fallbackAlt.text ? extractJSON(fallbackAlt.text) : null;
        if (!fallbackParsed) return res.json({ text: "I could not find detailed specs for " + pn + ". Could you provide the key specs to match (voltage, current, package)?", intent: intent, mode: "question" });
        var fbParts = (fallbackParsed.alternatives || fallbackParsed.results || []);
        var fbStock = await prefetchStock(fbParts.map(function(p) { return p.partNumber; }));
        fallbackParsed.stockData = fbStock;
        fallbackParsed.mode = "alt";
        return res.json(Object.assign({ text: "Here are alternatives for **" + pn + "**:", intent: intent }, fallbackParsed));
      }

      if (originalPart.isPassive) {
        return res.json({
          text: "For **" + pn + "** (" + originalPart.categoryName + "), parametric search gives the most accurate alternatives — it ensures exact spec matching.",
          mode: "passive_connector_alt",
          originalPart: pn,
          originalManufacturer: originalPart.manufacturer,
          originalDescription: originalPart.description,
          categoryName: originalPart.categoryName,
          searchLinks: [
            { name: "Digi-Key Search", url: originalPart.dkSearchUrl, description: "Filter by specs in parametric search" },
            { name: "Mouser Search", url: originalPart.mouserSearchUrl, description: "Find in-stock alternatives" },
            { name: "Octopart", url: originalPart.octopartUrl, description: "Compare across all distributors" },
          ],
          tips: ["Category: " + originalPart.categoryName, originalPart.specsText.substring(0, 150)],
          intent: intent,
        });
      }

      var altSystem = buildAltSystem(originalPart);
      var altResult = await callAI(altSystem, [{ role: "user", content: message }], 4000);
      var altData = altResult.text ? extractJSON(altResult.text) : null;
      if (!altData) return res.json({ text: "I had trouble finding alternatives for " + pn + ". Please try again.", intent: intent, mode: "text" });

      var altParts = altData.alternatives || [];
      var altStock = await prefetchStock(altParts.map(function(p) { return p.partNumber; }));
      altData.stockData = altStock;
      altData.mode = "alt";

      return res.json(Object.assign({
        text: "Here are **" + altParts.length + " alternatives** for **" + pn + "**, all meeting or exceeding its specs from DigiKey:",
        intent: intent,
      }, altData));
    }

    // GENERATE BOM
    if (intent === "generate_bom") {
      var bomCacheKey = "bom:" + message.toLowerCase().trim();
      var cachedBOM = getCached(aiCache, bomCacheKey);
      if (cachedBOM) { console.log("BOM cache hit"); return res.json(cachedBOM); }

      var bomResult = await callAI(BOM_SYSTEM, [{ role: "user", content: message }], 4000);
      var bomData = bomResult.text ? extractJSON(bomResult.text) : null;
      if (!bomData || !bomData.bomItems) {
        return res.json({ text: "I had trouble generating the BOM. Could you describe the application in more detail — voltage, current, key requirements?", intent: intent, mode: "question" });
      }

      var bomParts = bomData.bomItems.map(function(p) { return p.partNumber; });
      var bomStock = await prefetchStock(bomParts);
      bomData.stockData = bomStock;

      // Sort by stock
      bomData.bomItems = bomData.bomItems.sort(function(a, b) {
        var sa = bomStock[a.partNumber] ? bomStock[a.partNumber].totalStock : 0;
        var sb = bomStock[b.partNumber] ? bomStock[b.partNumber].totalStock : 0;
        return sb - sa;
      });

      var bomText = "Here is a **sourcing-ready BOM** for your **" + bomData.projectName + "** — " + bomData.bomItems.length + " critical components, verified on Digi-Key:";
      var bomResponse = Object.assign({ text: bomText, intent: intent }, bomData);
      setCache(aiCache, bomCacheKey, bomResponse, AI_TTL);
      return res.json(bomResponse);
    }

    // PART SEARCH (default)
    var searchCacheKey = "search:" + message.toLowerCase().trim();
    var cachedSearch = getCached(aiCache, searchCacheKey);
    if (cachedSearch) { console.log("Search cache hit"); return res.json(cachedSearch); }

    var searchResult = await callAI(SEARCH_SYSTEM, [{ role: "user", content: message }], 4000);
    var searchData = searchResult.text ? extractJSON(searchResult.text) : null;

    if (!searchData || !searchData.results) {
      var fallbackEng = await callAI(ENGINEERING_SYSTEM, fullMessages, 1500);
      return res.json({ text: fallbackEng.text || "I could not find specific parts for that query. Could you provide more details about the specs you need?", intent: intent, mode: "text" });
    }

    var searchParts = searchData.results.map(function(p) { return p.partNumber; });
    var searchStock = await prefetchStock(searchParts);
    searchData.stockData = searchStock;
    searchData.mode = "search";

    searchData.results = searchData.results.sort(function(a, b) {
      var sa = searchStock[a.partNumber] ? searchStock[a.partNumber].totalStock : 0;
      var sb = searchStock[b.partNumber] ? searchStock[b.partNumber].totalStock : 0;
      return sb - sa;
    });

    var searchText = "Found **" + searchData.results.length + " options** — " + (searchData.interpretation || "") + ". Sorted by stock availability:";
    var searchResponse = Object.assign({ text: searchText, intent: intent }, searchData);
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
    var contentType = req.headers["content-type"] || "";
    var filename = req.headers["x-filename"] || "bom.csv";

    // Parse CSV from raw body
    var fileContent = req.body.toString("utf8");
    var lines = fileContent.split("\n").filter(function(l) { return l.trim(); });
    if (lines.length === 0) return res.status(400).json({ error: "Empty file" });

    var headers = lines[0].split(",").map(function(h) { return h.replace(/"/g, "").trim().toLowerCase(); });
    var pnColIdx = 0;
    var pnKeywords = ["part number", "pn", "mpn", "part no", "partno", "part#", "component", "part_number"];
    for (var ki = 0; ki < pnKeywords.length; ki++) {
      for (var hi = 0; hi < headers.length; hi++) {
        if (headers[hi].indexOf(pnKeywords[ki]) !== -1) { pnColIdx = hi; break; }
      }
    }

    var partNumbers = [];
    for (var li = 1; li < lines.length; li++) {
      var cols = lines[li].split(",").map(function(c) { return c.replace(/"/g, "").trim(); });
      if (cols[pnColIdx]) partNumbers.push(cols[pnColIdx]);
    }

    if (partNumbers.length === 0) return res.status(400).json({ error: "No part numbers found. Make sure your CSV has a Part Number column." });

    console.log("Excel BOM:", partNumbers.length, "parts");

    var results = [];
    var limit = Math.min(partNumbers.length, 15);

    for (var pi = 0; pi < limit; pi++) {
      var pn = partNumbers[pi];
      if (!pn) continue;
      var stockData = await prefetchStock([pn]);
      var stock = stockData[pn] || {};
      var row = { partNumber: pn, description: "", category: "", keySpecs: "", stock: stock.totalStock || 0, bestPrice: stock.bestPrice || "", dkStock: stock.digikey ? stock.digikey.stock : 0, mousStock: stock.mouser ? stock.mouser.stock : 0, alt1: "", alt2: "", alt3: "" };

      try {
        var partInfo = await fetchPartSpecs(pn);
        if (partInfo) {
          row.description = partInfo.description;
          row.category = partInfo.categoryName;
          row.keySpecs = partInfo.specsText.substring(0, 100);

          if (!partInfo.isPassive) {
            var altSys = buildAltSystem(partInfo);
            var altRes = await callAI(altSys, [{ role: "user", content: "Find alternatives for " + pn }], 2000);
            var altParsed = altRes.text ? extractJSON(altRes.text) : null;
            if (altParsed && altParsed.alternatives) {
              var alts = altParsed.alternatives.slice(0, 3);
              if (alts[0]) row.alt1 = alts[0].partNumber + " (" + alts[0].manufacturer + ", " + (alts[0].compatibility || "") + ")";
              if (alts[1]) row.alt2 = alts[1].partNumber + " (" + alts[1].manufacturer + ")";
              if (alts[2]) row.alt3 = alts[2].partNumber + " (" + alts[2].manufacturer + ")";
            }
          }
        }
      } catch (e) { console.error("Alt lookup failed for " + pn, e.message); }

      results.push(row);
    }

    var csvHeaders = ["Part Number", "Description", "Category", "Key Specs", "Total Stock", "Best Price", "Digi-Key Stock", "Mouser Stock", "Alternative 1", "Alternative 2", "Alternative 3"];
    var csvRows = results.map(function(r) {
      return [r.partNumber, r.description, r.category, r.keySpecs, r.stock, r.bestPrice, r.dkStock, r.mousStock, r.alt1, r.alt2, r.alt3];
    });
    var csv = [csvHeaders].concat(csvRows).map(function(row) {
      return row.map(function(c) { return '"' + String(c || "").replace(/"/g, '""') + '"'; }).join(",");
    }).join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=BOM_PartTensor.csv");
    res.send(csv);

  } catch (err) {
    console.error("Excel BOM error:", err.message);
    res.status(500).json({ error: "Failed to process file: " + err.message });
  }
});

// =============================================
// START
// =============================================
var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log("\nPartTensor backend running on port " + PORT);
  console.log("  GET  /api/health");
  console.log("  POST /api/chat");
  console.log("  POST /api/excel-bom\n");
});
