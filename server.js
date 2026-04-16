const express = require("express");
const cors = require("cors");
require("dotenv").config();

console.log("=== Silicore Backend Starting ===");
console.log("Anthropic key:", process.env.ANTHROPIC_API_KEY ? "OK" : "MISSING");
console.log("DigiKey client ID:", process.env.DIGIKEY_CLIENT_ID ? "OK" : "MISSING");
console.log("Mouser API key:", process.env.MOUSER_API_KEY ? "OK" : "MISSING");

const app = express();
app.use(cors());
app.use(express.json());

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
// COMPONENT TYPE CLASSIFIER
// Determines if a part is semiconductor or passive/connector
// =============================================
var SEMICONDUCTOR_CATEGORIES = [
  "mosfet", "transistor", "igbt", "bjt", "op-amp", "opamp", "amplifier",
  "comparator", "regulator", "ldo", "dc-dc", "converter", "controller",
  "gate driver", "motor driver", "driver", "diode", "rectifier", "schottky",
  "zener", "tvs", "esd", "optocoupler", "oscillator", "microcontroller",
  "mcu", "sensor", "dac", "adc", "reference", "buffer", "logic",
];

var PASSIVE_CONNECTOR_CATEGORIES = [
  "connector", "receptacle", "plug", "socket", "header", "terminal",
  "resistor", "capacitor", "inductor", "ferrite", "crystal", "resonator",
  "transformer", "relay", "switch", "fuse", "varistor", "thermistor",
  "potentiometer", "trimmer", "antenna", "filter", "balun", "coupler",
  "mmcx", "sma", "bnc", "rj45", "usb", "hdmi", "rf connector",
  "coax", "coaxial", "jack", "pin header", "wire to board",
  "board to board", "d-sub", "circular", "fiber", "optical",
  "power connector", "battery connector", "cable assembly",
];

function classifyComponent(description, categoryName) {
  var text = ((description || "") + " " + (categoryName || "")).toLowerCase();

  for (var i = 0; i < SEMICONDUCTOR_CATEGORIES.length; i++) {
    if (text.indexOf(SEMICONDUCTOR_CATEGORIES[i]) !== -1) return "semiconductor";
  }
  for (var j = 0; j < PASSIVE_CONNECTOR_CATEGORIES.length; j++) {
    if (text.indexOf(PASSIVE_CONNECTOR_CATEGORIES[j]) !== -1) return "passive_connector";
  }
  return "semiconductor"; // default to semiconductor path
}

// =============================================
// DIGIKEY TOKEN
// =============================================
var digikeyToken = null;
var digikeyTokenExpiry = null;

async function getDigikeyToken() {
  if (digikeyToken && digikeyTokenExpiry && Date.now() < digikeyTokenExpiry) return digikeyToken;
  const fetch = (await import("node-fetch")).default;
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
// FETCH ORIGINAL PART FROM DIGIKEY
// =============================================
async function fetchOriginalPart(mpn) {
  try {
    const fetch = (await import("node-fetch")).default;
    var token = await getDigikeyToken();
    if (!token) return null;

    console.log("Fetching original part:", mpn);

    var product = null;
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
    var specsText = [];
    var keyParamsForSearch = [];

    for (var i = 0; i < parameters.length; i++) {
      var param = parameters[i];
      var name = (param.Parameter || "").toLowerCase();
      var value = param.Value || "";
      specsText.push(param.Parameter + ": " + value);

      var numVal = parseFloat(value);

      if ((name.includes("voltage") || name === "vds" || name === "vce" || name.includes("breakdown")) && !isNaN(numVal) && !specs.voltage) specs.voltage = numVal;
      if ((name.includes("continuous") && name.includes("current") || name === "id" || name === "ic" || name.includes("output current")) && !isNaN(numVal) && !specs.current) specs.current = numVal;
      if ((name.includes("rds") || name.includes("resistance")) && !isNaN(numVal) && !specs.resistance) specs.resistance = numVal;
      if (name.includes("power") && name.includes("dissipation") && !isNaN(numVal) && !specs.power) specs.power = numVal;
      if (name.includes("capacitance") && !isNaN(numVal) && !specs.capacitance) specs.capacitance = numVal;
      if (name.includes("inductance") && !isNaN(numVal) && !specs.inductance) specs.inductance = numVal;
      if ((name.includes("bandwidth") || name.includes("gbw")) && !isNaN(numVal) && !specs.bandwidth) specs.bandwidth = numVal;

      // Collect key params for DigiKey search URL
      if (keyParamsForSearch.length < 5 && value) {
        keyParamsForSearch.push(encodeURIComponent(param.Parameter) + "=" + encodeURIComponent(value));
      }
    }

    var categoryName = product.Category && product.Category.Name || "";
    var description = product.Description && product.Description.ProductDescription || "";
    var componentType = classifyComponent(description, categoryName);

    // Build DigiKey search URL for passives/connectors
    var digikeySearchUrl = "https://www.digikey.com/en/products/filter/" +
      encodeURIComponent(product.ManufacturerProductNumber || mpn) +
      "?stock=1";

    // Also build a category search URL
    var categorySearchUrl = null;
    if (product.Category && product.Category.CategoryId) {
      categorySearchUrl = "https://www.digikey.com/en/products/filter?stock=1&categoryId=" +
        product.Category.CategoryId;
    }

    console.log("Part type:", componentType, "| Category:", categoryName);
    console.log("Specs:", JSON.stringify(specs));

    return {
      mpn: product.ManufacturerProductNumber || mpn,
      manufacturer: product.Manufacturer && product.Manufacturer.Name || "",
      description: description,
      categoryId: product.Category && product.Category.CategoryId || null,
      categoryName: categoryName,
      componentType: componentType,
      package: product.PackageType || "",
      specs: specs,
      specsText: specsText.slice(0, 15).join("; "),
      digikeySearchUrl: digikeySearchUrl,
      categorySearchUrl: categorySearchUrl,
      stock: product.QuantityAvailable || 0,
      parameters: parameters,
    };
  } catch (e) {
    console.error("fetchOriginalPart failed:", e.message);
    return null;
  }
}

// =============================================
// DIGIKEY LOOKUP
// =============================================
async function lookupDigikey(mpn) {
  try {
    const fetch = (await import("node-fetch")).default;
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
        found: true, distributor: "Digi-Key", stock: product.QuantityAvailable || 0,
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
      body: JSON.stringify({ Keywords: mpn, Limit: 5, Offset: 0, FilterOptionsRequest: { InStock: false } }),
    });

    if (!res2.ok) return null;
    var data2 = await res2.json();
    var products = data2.Products || [];
    if (products.length === 0) return null;

    var best = products[0];
    for (var i = 0; i < products.length; i++) {
      if ((products[i].QuantityAvailable || 0) > (best.QuantityAvailable || 0)) best = products[i];
    }
    var unitPrice2 = best.UnitPrice || (best.StandardPricing && best.StandardPricing[0] && best.StandardPricing[0].UnitPrice) || null;
    return {
      found: true, distributor: "Digi-Key", stock: best.QuantityAvailable || 0,
      price: unitPrice2 ? "$" + parseFloat(unitPrice2).toFixed(3) : null,
      url: best.ProductUrl || "https://www.digikey.com/en/products/filter/" + encodeURIComponent(mpn),
      matchedPart: best.ManufacturerProductNumber || mpn,
    };
  } catch (e) { console.error("DigiKey lookup failed for " + mpn + ":", e.message); return null; }
}

// =============================================
// MOUSER LOOKUP
// =============================================
async function lookupMouser(mpn) {
  try {
    const fetch = (await import("node-fetch")).default;
    var res = await fetch(
      "https://api.mouser.com/api/v1/search/partnumber?apiKey=" + process.env.MOUSER_API_KEY,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: "Begins With" } }) }
    );
    if (res.ok) {
      var data = await res.json();
      var parts = data.SearchResults && data.SearchResults.Parts;
      if (parts && parts.length > 0) {
        var best = parts[0];
        for (var i = 0; i < parts.length; i++) {
          if (parseInt((parts[i].Availability || "0").replace(/[^0-9]/g, "")) > parseInt((best.Availability || "0").replace(/[^0-9]/g, ""))) best = parts[i];
        }
        var stock = parseInt((best.Availability || "0").replace(/[^0-9]/g, "")) || 0;
        var price = best.PriceBreaks && best.PriceBreaks[0] && best.PriceBreaks[0].Price;
        return { found: true, distributor: "Mouser", stock: stock, price: price || null, url: best.ProductDetailUrl || "https://www.mouser.com/Search/Refine?Keyword=" + encodeURIComponent(mpn), matchedPart: best.ManufacturerPartNumber || mpn };
      }
    }
    var res2 = await fetch(
      "https://api.mouser.com/api/v1/search/keyword?apiKey=" + process.env.MOUSER_API_KEY,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ SearchByKeywordRequest: { keyword: mpn, records: 5, startingRecord: 0, searchOptions: "BeginsWith" } }) }
    );
    if (!res2.ok) return null;
    var data2 = await res2.json();
    var parts2 = data2.SearchResults && data2.SearchResults.Parts;
    if (!parts2 || parts2.length === 0) return null;
    var best2 = parts2[0];
    for (var j = 0; j < parts2.length; j++) {
      if (parseInt((parts2[j].Availability || "0").replace(/[^0-9]/g, "")) > parseInt((best2.Availability || "0").replace(/[^0-9]/g, ""))) best2 = parts2[j];
    }
    var stock2 = parseInt((best2.Availability || "0").replace(/[^0-9]/g, "")) || 0;
    var price2 = best2.PriceBreaks && best2.PriceBreaks[0] && best2.PriceBreaks[0].Price;
    return { found: true, distributor: "Mouser", stock: stock2, price: price2 || null, url: best2.ProductDetailUrl || "https://www.mouser.com/Search/Refine?Keyword=" + encodeURIComponent(mpn), matchedPart: best2.ManufacturerPartNumber || mpn };
  } catch (e) { console.error("Mouser lookup failed for " + mpn + ":", e.message); return null; }
}

// =============================================
// VERIFY PARTS ON DIGIKEY
// =============================================
async function verifyAndEnrichParts(parts) {
  if (!parts || parts.length === 0) return parts;
  var verified = [];
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (!part.partNumber) continue;
    var dkResult = await lookupDigikey(part.partNumber);
    if (!dkResult) { console.log("  NOT FOUND:", part.partNumber, "— removing"); continue; }
    part.partNumber = dkResult.matchedPart || part.partNumber;
    part._dkStock = dkResult.stock;
    verified.push(part);
    console.log("  OK:", part.partNumber, "stock=" + dkResult.stock);
  }
  if (verified.length === 0) return parts;
  verified.sort(function(a, b) { return (b._dkStock || 0) - (a._dkStock || 0); });
  return verified;
}

// =============================================
// SPEC VALIDATOR
// =============================================
function validateSpecs(parts, req) {
  if (!parts || parts.length === 0) return parts;
  if (!req || !Object.keys(req).some(function(k) { return req[k] != null; })) return parts;
  var EXCEED = {
    voltage: ["vds", "vce", "vceo", "vcc", "vdd", "vrrm", "vrwm", "vr", "working voltage", "breakdown voltage", "rated voltage", "max voltage"],
    current: ["id", "ic", "if", "iout", "drain current", "collector current", "output current", "forward current", "continuous current", "rated current", "max current", "continuous drain current"],
    power: ["pd", "ptot", "power dissipation", "rated power", "max power"],
  };
  var MATCH = { capacitance: ["capacitance"], inductance: ["inductance"] };
  var validated = [];
  for (var pi = 0; pi < parts.length; pi++) {
    var part = parts[pi];
    var passes = true;
    var reason = "";
    if (part.keySpecs && Array.isArray(part.keySpecs)) {
      for (var i = 0; i < part.keySpecs.length && passes; i++) {
        var spec = part.keySpecs[i];
        var label = (spec.label || "").toLowerCase().trim();
        var value = parseFloat(spec.value);
        if (isNaN(value)) continue;
        for (var param in EXCEED) {
          if (!req[param]) continue;
          for (var li = 0; li < EXCEED[param].length; li++) {
            if (label === EXCEED[param][li] || label.indexOf(EXCEED[param][li]) !== -1) {
              if (value < req[param] * 0.95) { reason = spec.label + "=" + value + " < " + req[param]; passes = false; }
              break;
            }
          }
          if (!passes) break;
        }
        for (var mp in MATCH) {
          if (!req[mp]) continue;
          for (var mli = 0; mli < MATCH[mp].length; mli++) {
            if (label === MATCH[mp][mli] || label.indexOf(MATCH[mp][mli]) !== -1) {
              if (Math.abs(value - req[mp]) / req[mp] > 0.20) { reason = spec.label + "=" + value + " != " + req[mp]; passes = false; }
              break;
            }
          }
          if (!passes) break;
        }
      }
    }
    if (!passes) { console.log("  SPEC REJECTED", part.partNumber + ":", reason); }
    else validated.push(part);
  }
  return validated.length > 0 ? validated : parts;
}

function parseSpecsFromQuery(query) {
  var lower = query.toLowerCase();
  var req = {};
  var vm = lower.match(/(\d+(?:\.\d+)?)\s*v\b/); if (vm) req.voltage = parseFloat(vm[1]);
  var am = lower.match(/(\d+(?:\.\d+)?)\s*a\b/); if (am) req.current = parseFloat(am[1]);
  var wm = lower.match(/(\d+(?:\.\d+)?)\s*w\b/); if (wm) req.power = parseFloat(wm[1]);
  var ufm = lower.match(/(\d+(?:\.\d+)?)\s*uf\b/); if (ufm) req.capacitance = parseFloat(ufm[1]);
  var uhm = lower.match(/(\d+(?:\.\d+)?)\s*uh\b/); if (uhm) req.inductance = parseFloat(uhm[1]);
  return req;
}

function isAlternativeQuery(query) {
  var lower = query.toLowerCase();
  var kw = ["alternative", "alternatives", "alt", "replacement", "replace", "substitute",
    "equivalent", "similar to", "instead of", "out of stock", "unavailable", "cheaper",
    "cross reference", "crossref", "drop in", "drop-in"];
  for (var i = 0; i < kw.length; i++) { if (lower.indexOf(kw[i]) !== -1) return true; }
  return false;
}

function extractPartNumber(query) {
  // Remove common words that are not part numbers
  var lower = query.toLowerCase();
  var stopWords = ["alternative", "alternatives", "alt", "replacement", "replace",
    "substitute", "equivalent", "similar", "instead", "stock", "unavailable",
    "cheaper", "cross", "reference", "drop", "find", "for", "me", "the", "a", "an"];

  // Pattern 1: Standard part numbers starting with letters e.g. IRF540N, LM358
  var matches1 = query.match(/\b([A-Z]{1,6}[0-9]{2,}[A-Z0-9\-]*)\b/gi) || [];

  // Pattern 2: Part numbers starting with digits e.g. 1-966066-0, 0734151001
  var matches2 = query.match(/\b([0-9]+[\-][0-9A-Z][\-0-9A-Z]*)\b/gi) || [];

  // Pattern 3: All-numeric part numbers e.g. 0734151001
  var matches3 = query.match(/\b([0-9]{7,})\b/gi) || [];

  var allMatches = matches1.concat(matches2).concat(matches3);

  // Remove stop words and short matches
  allMatches = allMatches.filter(function(m) {
    return stopWords.indexOf(m.toLowerCase()) === -1 && m.length >= 4;
  });

  if (allMatches.length === 0) return null;

  // Return longest match — most likely to be full part number
  return allMatches.sort(function(a, b) { return b.length - a.length; })[0];
}

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

async function callAI(system, query) {
  const fetch = (await import("node-fetch")).default;
  var models = ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"];
  for (var attempt = 1; attempt <= 3; attempt++) {
    var model = attempt <= 2 ? models[0] : models[1];
    try {
      var aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: model, max_tokens: 3000, system: system, messages: [{ role: "user", content: query }] }),
      });
      var aiData = await aiRes.json();
      if (aiData.error && aiData.error.type === "overloaded_error") {
        await new Promise(function(r) { setTimeout(r, attempt * 3000); });
        continue;
      }
      if (aiData.error) return { error: aiData.error.message };
      var text = (aiData.content || []).map(function(b) { return b.text || ""; }).join("");
      var parsed = extractJSON(text);
      if (!parsed) { if (attempt < 3) continue; return { error: "parse_failed" }; }
      return { data: parsed };
    } catch (err) {
      if (attempt < 3) await new Promise(function(r) { setTimeout(r, 2000); });
    }
  }
  return { error: "All retries failed." };
}

// =============================================
// SYSTEM PROMPTS
// =============================================
var BOM_PROMPT = [
  "You are a senior hardware application engineer. Generate a smart Bill of Materials.",
  "RULES:",
  "- Only critical components: MOSFETs, ICs, drivers, specialized inductors, electrolytic caps,",
  "  current sense resistors, crystals, connectors, optocouplers, diodes, sensors",
  "- NO generic resistors, 100nF caps, generic LEDs",
  "- Use FULL part numbers exactly as on Digi-Key",
  "- Include 5 keySpecs per part with exact numeric values",
  "- All parts must meet or exceed required specifications",
  "Respond ONLY raw JSON starting with {:",
  "{\"projectName\":\"name\",\"description\":\"sentence\",\"voltage\":\"V\",\"power\":\"W\",",
  "\"bomItems\":[{\"id\":1,\"function\":\"Gate Driver\",\"partNumber\":\"IR2184SPBF\",",
  "\"manufacturer\":\"Infineon\",\"description\":\"one line\",\"category\":\"IC\",",
  "\"quantity\":1,\"keySpecs\":\"600V 2A SO-8\",\"package\":\"SO-8\",",
  "\"priority\":\"critical\",\"unitPrice\":\"$1.20\",\"notes\":null}],",
  "\"designNotes\":\"notes\",\"totalEstimate\":\"$15-25\"}",
].join("\n");

var SEARCH_PROMPT = [
  "You are a senior application engineer. Find the best components for the described need.",
  "RULES:",
  "- ONLY suggest parts that ACTUALLY EXIST on Digi-Key",
  "- Use FULL exact part numbers as listed on Digi-Key",
  "- Only use well-known manufacturers: Infineon, Vishay, ON Semi, TI, STMicro,",
  "  Analog Devices, Microchip, Renesas, Rohm, Nexperia, Diodes Inc",
  "- ALL parts must meet or EXCEED requested specifications",
  "- Include exactly 5 keySpecs per part:",
  "  1. Main voltage rating, 2. Main current rating, 3. Key performance spec,",
  "  4. Secondary spec, 5. Package",
  "Respond ONLY raw JSON starting with {:",
  "{\"mode\":\"search\",\"category\":\"N-Channel MOSFET\",\"interpretation\":\"one sentence\",",
  "\"results\":[{\"partNumber\":\"IRF540NPBF\",\"manufacturer\":\"Vishay\",",
  "\"type\":\"N-Channel MOSFET\",",
  "\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"100\",\"unit\":\"V\"},",
  "{\"label\":\"ID\",\"value\":\"33\",\"unit\":\"A\"},",
  "{\"label\":\"RDS(on)\",\"value\":\"44\",\"unit\":\"mΩ\"},",
  "{\"label\":\"Qg\",\"value\":\"71\",\"unit\":\"nC\"},",
  "{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],",
  "\"package\":\"TO-220\",\"applications\":[\"Motor Drive\"],",
  "\"rank\":\"top\",\"aeComment\":\"Meets all specs.\",\"caution\":null}],",
  "\"designTip\":\"tip\"}",
].join("\n");

// Semiconductor alternative prompt — uses real specs from DigiKey
function buildSemiconductorAltPrompt(originalPart) {
  var specs = originalPart.specs || {};
  var specLines = [];
  if (specs.voltage) specLines.push("- Voltage rating >= " + specs.voltage + "V");
  if (specs.current) specLines.push("- Current rating >= " + specs.current + "A");
  if (specs.resistance) specLines.push("- On-resistance <= " + specs.resistance + " (lower is better)");
  if (specs.power) specLines.push("- Power dissipation >= " + specs.power + "W");
  if (specs.bandwidth) specLines.push("- Bandwidth >= " + specs.bandwidth);
  if (specs.capacitance) specLines.push("- Capacitance within 20% of " + specs.capacitance);
  if (specs.inductance) specLines.push("- Inductance within 20% of " + specs.inductance);

  if (specLines.length === 0) {
    specLines.push("- Match or exceed all specs of: " + originalPart.specsText.substring(0, 200));
  }

  return [
    "You are a senior application engineer finding alternatives for:",
    originalPart.mpn + " by " + originalPart.manufacturer,
    "Description: " + originalPart.description,
    "Category: " + originalPart.categoryName,
    "",
    "REAL SPECS FROM DATASHEET (fetched from Digi-Key):",
    specLines.join("\n"),
    "",
    "STRICT RULES:",
    "- Find 3-5 alternatives that meet or exceed ALL specs listed above",
    "- ONLY suggest parts that ACTUALLY EXIST on Digi-Key with real stock",
    "- Use FULL exact part numbers as on Digi-Key",
    "- From DIFFERENT manufacturers than " + originalPart.manufacturer,
    "- Preferred: Infineon, Vishay, ON Semi, TI, STMicro, Analog Devices, Rohm, Renesas",
    "- Include exactly 5 keySpecs per part with numeric values",
    "- First spec must be voltage rating, second must be current rating",
    "- NEVER suggest lower specs — if unsure, suggest higher specs",
    "",
    "Respond ONLY raw JSON starting with {:",
    "{\"mode\":\"alt\",\"originalPart\":\"" + originalPart.mpn + "\",",
    "\"originalSpecs\":\"" + specLines.join(", ") + "\",",
    "\"reason\":\"one sentence why alternatives are needed\",",
    "\"alternatives\":[{",
    "\"partNumber\":\"IRFB4115GPBF\",\"manufacturer\":\"Vishay\",",
    "\"type\":\"N-Channel MOSFET\",\"compatibility\":\"drop-in\",",
    "\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"150\",\"unit\":\"V\"},",
    "{\"label\":\"ID\",\"value\":\"104\",\"unit\":\"A\"},",
    "{\"label\":\"RDS(on)\",\"value\":\"11\",\"unit\":\"mΩ\"},",
    "{\"label\":\"Qg\",\"value\":\"120\",\"unit\":\"nC\"},",
    "{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],",
    "\"package\":\"TO-220\",",
    "\"whyAlternative\":\"Exceeds all original specs. In stock on Digi-Key.\",",
    "\"differences\":\"slightly higher Rds but pin compatible\"}],",
    "\"importantNote\":\"Verify gate drive and thermal requirements before use\"}",
  ].join("\n");
}

// =============================================
// ROUTE 1 — AI Search
// =============================================
app.post("/api/search", async function(req, res) {
  try {
    var query = req.body.query;
    var mode = req.body.mode;
    if (!query) return res.status(400).json({ error: "Query is required" });

    var cacheKey = (mode || "search") + ":" + query.toLowerCase().trim();
    var cached = getCached(aiCache, cacheKey);
    if (cached) { console.log("Cache hit:", cacheKey.substring(0, 60)); return res.json(cached); }

    console.log("\n[" + (mode || "search").toUpperCase() + "]", query.substring(0, 80));

    var responseData;

    if (mode === "search" && isAlternativeQuery(query)) {
      // =========================================
      // ALTERNATIVE FINDER — SMART ROUTING
      // =========================================
      var originalPn = extractPartNumber(query);
      var originalPart = null;

      if (originalPn) {
        originalPart = await fetchOriginalPart(originalPn);
      }

      if (!originalPart) {
        // Part not found on DigiKey — fall back to general search
        console.log("Part not found — falling back to search");
        var fb = await callAI(SEARCH_PROMPT, query);
        if (fb.error) return res.status(503).json({ error: fb.error });
        responseData = fb.data;

      } else if (originalPart.componentType === "passive_connector") {
        // ---- PASSIVE / CONNECTOR PATH ----
        // Do NOT ask AI to guess part numbers
        // Return DigiKey search links instead
        console.log("Passive/connector detected — returning DigiKey search links");

        // Build smart DigiKey search URL using original part specs
        // Use first 4-5 meaningful words from description as search keyword
var descWords = (originalPart.description || "")
  .replace(/[^a-zA-Z0-9\s]/g, " ")
  .split(/\s+/)
  .filter(function(w) { return w.length > 2; })
  .slice(0, 5)
  .join(" ");

var searchKeyword = descWords || originalPart.categoryName;

// DigiKey correct search URL format
var dkSearchUrl = "https://www.digikey.com/en/products/result?keywords=" +
  encodeURIComponent(searchKeyword) + "&stock=1";

// Mouser correct search URL format  
var mouserSearchUrl = "https://www.mouser.com/Search/Refine?Keyword=" +
  encodeURIComponent(searchKeyword) + "&inStock=1";

// Octopart correct URL
var octopartUrl = "https://octopart.com/search?q=" +
  encodeURIComponent(searchKeyword) + "&in_stock=1";

        responseData = {
          mode: "passive_connector_alt",
          originalPart: originalPart.mpn,
          originalManufacturer: originalPart.manufacturer,
          originalDescription: originalPart.description,
          originalSpecs: originalPart.specsText.substring(0, 300),
          componentType: originalPart.componentType,
          categoryName: originalPart.categoryName,
          message: "For connectors and passives, parametric search gives the most accurate results. Use these links to find in-stock alternatives with matching specs:",
          searchLinks: [
                {
                  name: "🔵 Search Digi-Key",
                  url: dkSearchUrl,
                  description: "Filter by specs in Digi-Key's parametric search",
                },
                {
                  name: "🟣 Search Mouser",
                  url: mouserSearchUrl,
                  description: "Find in-stock alternatives on Mouser",
                },
                {
                  name: "🔍 Search Octopart",
                  url: octopartUrl,
                  description: "Compare across all distributors",
                },
           ],
          tips: [
            "Filter by: " + originalPart.categoryName,
            "Key specs to match: " + originalPart.specsText.substring(0, 150),
            "Exclude manufacturer: " + originalPart.manufacturer + " (likely same shortage)",
          ],
        };

      } else {
        // ---- SEMICONDUCTOR PATH ----
        // AI with real specs from DigiKey
        console.log("Semiconductor detected — using AI with real specs");
        var altPrompt = buildSemiconductorAltPrompt(originalPart);
        var altResult = await callAI(altPrompt, query);

        if (altResult.error) {
          return res.status(503).json({ error: altResult.error });
        }

        // Validate specs using real DigiKey data
        if (altResult.data && altResult.data.alternatives) {
          altResult.data.alternatives = validateSpecs(
            altResult.data.alternatives,
            originalPart.specs
          );
          // Verify parts exist on DigiKey
          console.log("\nVerifying alternatives on DigiKey...");
          altResult.data.alternatives = await verifyAndEnrichParts(altResult.data.alternatives);
        }

        responseData = altResult.data;
      }

    } else if (mode === "search") {
      // =========================================
      // COMPONENT SEARCH
      // =========================================
      var searchResult = await callAI(SEARCH_PROMPT, query);
      if (searchResult.error) {
        if (searchResult.error === "parse_failed") return res.status(500).json({ error: "Could not parse AI response. Please try again." });
        return res.status(503).json({ error: searchResult.error });
      }
      if (searchResult.data && searchResult.data.results) {
        var querySpecs = parseSpecsFromQuery(query);
        searchResult.data.results = validateSpecs(searchResult.data.results, querySpecs);
        console.log("\nVerifying on DigiKey...");
        searchResult.data.results = await verifyAndEnrichParts(searchResult.data.results);
      }
      responseData = searchResult.data;

    } else {
      // =========================================
      // BOM GENERATOR
      // =========================================
      var bomResult = await callAI(BOM_PROMPT, query);
      if (bomResult.error) {
        if (bomResult.error === "parse_failed") return res.status(500).json({ error: "Could not parse AI response. Please try again." });
        return res.status(503).json({ error: bomResult.error });
      }
      responseData = bomResult.data;
    }

    setCache(aiCache, cacheKey, responseData, AI_TTL);
    res.json(responseData);

  } catch (err) {
    console.error("Search route error:", err.message, err.stack);
    res.status(500).json({ error: "Search failed: " + err.message });
  }
});

// =============================================
// ROUTE 2 — Stock from Digi-Key + Mouser
// =============================================
app.post("/api/stock", async function(req, res) {
  try {
    var partNumbers = req.body.partNumbers;
    if (!partNumbers || !Array.isArray(partNumbers)) return res.status(400).json({ error: "partNumbers array is required" });

    console.log("\nStock lookup:", partNumbers.join(", "));
    var stockData = {};

    for (var pi = 0; pi < partNumbers.length; pi++) {
      var mpn = partNumbers[pi];
      if (!mpn) continue;
      var cached = getCached(stockCache, mpn);
      if (cached) { stockData[mpn] = cached; continue; }

      var results = await Promise.all([lookupDigikey(mpn), lookupMouser(mpn)]);
      var dk = results[0];
      var mouser = results[1];

      console.log(" ", mpn, "-> DK:", dk ? dk.stock : "N/A", "| MO:", mouser ? mouser.stock : "N/A");

      var distributors = [];
      if (dk && dk.stock > 0) distributors.push({ name: "Digi-Key", stock: dk.stock, price: dk.price, url: dk.url });
      if (mouser && mouser.stock > 0) distributors.push({ name: "Mouser", stock: mouser.stock, price: mouser.price, url: mouser.url });
      distributors.sort(function(a, b) { return b.stock - a.stock; });

      var totalStock = (dk ? dk.stock : 0) + (mouser ? mouser.stock : 0);
      var bestPrice = null, bestPriceSource = null;
      if (dk && dk.price) { bestPrice = dk.price; bestPriceSource = "Digi-Key"; }
      if (mouser && mouser.price) {
        var mv = parseFloat((mouser.price || "999").replace(/[^0-9.]/g, "")) || 999;
        var cv = parseFloat((bestPrice || "999").replace(/[^0-9.]/g, "")) || 999;
        if (mv < cv) { bestPrice = mouser.price; bestPriceSource = "Mouser"; }
      }

      var stockResult = {
        found: totalStock > 0, totalStock: totalStock,
        bestPrice: bestPrice, bestPriceSource: bestPriceSource,
        distributors: distributors, digikey: dk, mouser: mouser,
        octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(mpn),
      };
      setCache(stockCache, mpn, stockResult, STOCK_TTL);
      stockData[mpn] = stockResult;
    }

    res.json(stockData);
  } catch (err) {
    console.error("Stock route error:", err.message);
    res.status(500).json({ error: "Stock lookup failed: " + err.message });
  }
});

app.get("/api/health", function(req, res) {
  res.json({ status: "ok", service: "PartTensor", time: new Date().toISOString() });
});


// =============================================
// START SERVER
// =============================================
var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log("\nSilicore v4 running on http://localhost:" + PORT);
  console.log("  POST /api/search — Smart routing: AI for semiconductors, DigiKey links for passives/connectors");
  console.log("  POST /api/stock  — Digi-Key + Mouser live stock\n");
});