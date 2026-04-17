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
      return { found: true, stock: product.QuantityAvailable || 0, price: unitPrice ? "$" + parseFloat(unitPrice).toFixed(3) : null, url: product.ProductUrl || "https://www.digikey.com/en/products/filter/" + encodeURIComponent(mpn), matchedPart: product.ManufacturerProductNumber || mpn };
    }
    var res2 = await fetch("https://api.digikey.com/products/v4/search/keyword", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD", "Content-Type": "application/json" },
      body: JSON.stringify({ Keywords: mpn, Limit: 5, Offset: 0 }),
    });
    if (!res2.ok) return null;
    var data2 = await res2.json();
    var products = data2.Products || [];
    if (products.length === 0) return null;
    var best = products.reduce(function(a, b) { return (b.QuantityAvailable || 0) > (a.QuantityAvailable || 0) ? b : a; });
    var unitPrice2 = best.UnitPrice || (best.StandardPricing && best.StandardPricing[0] && best.StandardPricing[0].UnitPrice) || null;
    return { found: true, stock: best.QuantityAvailable || 0, price: unitPrice2 ? "$" + parseFloat(unitPrice2).toFixed(3) : null, url: best.ProductUrl || "https://www.digikey.com/en/products/filter/" + encodeURIComponent(mpn), matchedPart: best.ManufacturerProductNumber || mpn };
  } catch (e) { console.error("DK lookup failed for " + mpn + ":", e.message); return null; }
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
    return { found: true, stock: stock, price: price || null, url: best.ProductDetailUrl || "https://www.mouser.com/Search/Refine?Keyword=" + encodeURIComponent(mpn), matchedPart: best.ManufacturerPartNumber || mpn };
  } catch (e) { console.error("Mouser lookup failed for " + mpn + ":", e.message); return null; }
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
    var bestPrice = null, bestPriceSource = null;
    if (dk && dk.price) { bestPrice = dk.price; bestPriceSource = "Digi-Key"; }
    if (mouser && mouser.price) {
      var mv = parseFloat((mouser.price || "999").replace(/[^0-9.]/g, "")) || 999;
      var cv = parseFloat((bestPrice || "999").replace(/[^0-9.]/g, "")) || 999;
      if (mv < cv) { bestPrice = mouser.price; bestPriceSource = "Mouser"; }
    }
    var sr = { found: total > 0, totalStock: total, bestPrice: bestPrice, bestPriceSource: bestPriceSource, digikey: dk, mouser: mouser, octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(mpn) };
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
      { method: "GET", headers: { "Authorization": "Bearer " + token, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD" } }
    );
    var product = null;
    if (res.ok) {
      var data = await res.json();
      product = data.Product || data;
    } else {
      var res2 = await fetch("https://api.digikey.com/products/v4/search/keyword", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD", "Content-Type": "application/json" },
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
  } catch (e) { console.error("fetchPartSpecs failed:", e.message); return null; }
}

// =============================================
// UNIVERSAL SPEC SYSTEM
// Works for every component type
// =============================================

// Each spec has:
//   labels     - what to look for in keySpecs label field
//   reqKey     - key in requiredSpecs object
//   direction  - "min" (part must meet or exceed), "max" (part must be equal or lower), "exact" (within tolerance)
//   tolerance  - for "exact" specs, allowed % deviation (0.05 = 5%)
//   unit       - base unit for display
//   primary    - if true, this is the main spec to sort by closeness

var SPEC_DEFINITIONS = [
  // MOSFETs / BJTs / Diodes - voltage
  { labels: ["vds","vce","vceo","vrrm","vrwm","vr","breakdown voltage","rated voltage","max voltage","working voltage","vcc max","vdd max"], reqKey: "voltage", direction: "min", primary: true, unit: "V" },
  // Current
  { labels: ["id","ic","if","iout","drain current","collector current","forward current","output current","continuous current","rated current","max current","continuous drain current"], reqKey: "current", direction: "min", primary: false, unit: "A" },
  { labels: ["id","ic","if","iout","drain current","collector current","forward current","output current","continuous current","rated current"], reqKey: "currentMA", direction: "min", primary: false, unit: "mA", scale: 0.001 },
  // Power
  { labels: ["pd","ptot","power dissipation","rated power","max power","total power"], reqKey: "power", direction: "min", primary: false, unit: "W" },
  { labels: ["pd","ptot","power dissipation","rated power","max power"], reqKey: "powerMW", direction: "min", primary: false, unit: "mW", scale: 0.001 },
  // Rds / Ron - lower is better
  { labels: ["rds","rds(on)","ron","on resistance","rdson"], reqKey: "rdsMax", direction: "max", primary: true, unit: "mOhm" },
  // Capacitance - exact match
  { labels: ["capacitance","cap","c"], reqKey: "capacitanceUF", direction: "exact", tolerance: 0.20, primary: true, unit: "uF" },
  { labels: ["capacitance","cap","c"], reqKey: "capacitanceNF", direction: "exact", tolerance: 0.20, primary: true, unit: "nF", scale: 0.001 },
  { labels: ["capacitance","cap","c"], reqKey: "capacitancePF", direction: "exact", tolerance: 0.20, primary: true, unit: "pF", scale: 0.000001 },
  // Inductance - exact match
  { labels: ["inductance","ind","l"], reqKey: "inductanceUH", direction: "exact", tolerance: 0.20, primary: true, unit: "uH" },
  { labels: ["inductance","ind","l"], reqKey: "inductanceNH", direction: "exact", tolerance: 0.20, primary: true, unit: "nH", scale: 0.001 },
  { labels: ["inductance","ind","l"], reqKey: "inductanceMH", direction: "exact", tolerance: 0.20, primary: true, unit: "mH", scale: 1000 },
  // Resistance - exact match
  { labels: ["resistance","res","r"], reqKey: "resistanceKOhm", direction: "exact", tolerance: 0.10, primary: true, unit: "kOhm" },
  { labels: ["resistance","res","r"], reqKey: "resistanceOhm", direction: "exact", tolerance: 0.10, primary: true, unit: "Ohm", scale: 0.001 },
  // GBW / Bandwidth for op-amps - higher is better (min)
  { labels: ["gbw","gain bandwidth","unity gain","bandwidth","gain-bandwidth product"], reqKey: "gbwMHz", direction: "min", primary: true, unit: "MHz" },
  // Frequency for oscillators / crystals - exact
  { labels: ["frequency","freq","oscillation frequency"], reqKey: "freqMHz", direction: "exact", tolerance: 0.01, primary: true, unit: "MHz" },
  { labels: ["frequency","freq","oscillation frequency"], reqKey: "freqKHz", direction: "exact", tolerance: 0.01, primary: true, unit: "kHz", scale: 0.001 },
  // Noise voltage - lower is better (max)
  { labels: ["noise","en","vn","voltage noise","input noise","noise density"], reqKey: "noiseNV", direction: "max", primary: false, unit: "nV" },
  // Dropout voltage for LDOs - lower is better (max)
  { labels: ["dropout","vdo","dropout voltage","vdropout"], reqKey: "dropoutMV", direction: "max", primary: false, unit: "mV" },
  // Output voltage for regulators - exact
  { labels: ["output voltage","vout","vo"], reqKey: "outputV", direction: "exact", tolerance: 0.05, primary: true, unit: "V" },
  // Temperature rating - min
  { labels: ["operating temperature","temp range","junction temperature","max temp"], reqKey: "tempC", direction: "min", primary: false, unit: "C" },
  // Forward voltage for diodes/LEDs - exact
  { labels: ["forward voltage","vf","vforward"], reqKey: "forwardV", direction: "exact", tolerance: 0.15, primary: true, unit: "V" },
  // Switching frequency for converters
  { labels: ["switching frequency","fsw","frequency"], reqKey: "switchFreqKHz", direction: "min", primary: false, unit: "kHz" },
  // Slew rate for op-amps - higher is better
  { labels: ["slew rate","sr"], reqKey: "slewRateVus", direction: "min", primary: false, unit: "V/us" },
  // Input offset voltage for op-amps - lower is better
  { labels: ["input offset","vos","offset voltage"], reqKey: "offsetMV", direction: "max", primary: false, unit: "mV" },
];

// =============================================
// EXTRACT REQUIRED SPECS FROM QUERY
// Universal - handles all component types
// =============================================
function extractRequiredSpecs(query) {
  var lower = query.toLowerCase();
  var specs = {};

  // Voltage - V
  var vMatches = lower.match(/(\d+(?:\.\d+)?)\s*v\b/gi) || [];
  if (vMatches.length > 0) {
    var volts = vMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; });
    if (volts.length > 0) specs.voltage = Math.max.apply(null, volts);
  }

  // Current - A
  var aMatches = lower.match(/(\d+(?:\.\d+)?)\s*a\b/gi) || [];
  if (aMatches.length > 0) {
    var amps = aMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; });
    if (amps.length > 0) specs.current = Math.max.apply(null, amps);
  }

  // Current - mA
  var maMatches = lower.match(/(\d+(?:\.\d+)?)\s*ma\b/gi) || [];
  if (maMatches.length > 0 && !specs.current) {
    var mamps = maMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v); });
    if (mamps.length > 0) specs.currentMA = Math.max.apply(null, mamps);
  }

  // Power - W
  var wMatches = lower.match(/(\d+(?:\.\d+)?)\s*w\b/gi) || [];
  if (wMatches.length > 0) {
    var watts = wMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0.1; });
    if (watts.length > 0) specs.power = Math.max.apply(null, watts);
  }

  // Power - mW
  var mwMatches = lower.match(/(\d+(?:\.\d+)?)\s*mw\b/gi) || [];
  if (mwMatches.length > 0 && !specs.power) {
    var mwatts = mwMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v); });
    if (mwatts.length > 0) specs.powerMW = Math.max.apply(null, mwatts);
  }

  // Capacitance - uF
  var ufMatches = lower.match(/(\d+(?:\.\d+)?)\s*uf\b/gi) || [];
  if (ufMatches.length > 0) specs.capacitanceUF = parseFloat(ufMatches[0]);

  // Capacitance - nF
  var nfMatches = lower.match(/(\d+(?:\.\d+)?)\s*nf\b/gi) || [];
  if (nfMatches.length > 0 && !specs.capacitanceUF) specs.capacitanceNF = parseFloat(nfMatches[0]);

  // Capacitance - pF
  var pfMatches = lower.match(/(\d+(?:\.\d+)?)\s*pf\b/gi) || [];
  if (pfMatches.length > 0 && !specs.capacitanceUF && !specs.capacitanceNF) specs.capacitancePF = parseFloat(pfMatches[0]);

  // Inductance - uH
  var uhMatches = lower.match(/(\d+(?:\.\d+)?)\s*uh\b/gi) || [];
  if (uhMatches.length > 0) specs.inductanceUH = parseFloat(uhMatches[0]);

  // Inductance - nH
  var nhMatches = lower.match(/(\d+(?:\.\d+)?)\s*nh\b/gi) || [];
  if (nhMatches.length > 0 && !specs.inductanceUH) specs.inductanceNH = parseFloat(nhMatches[0]);

  // Inductance - mH
  var mhMatches = lower.match(/(\d+(?:\.\d+)?)\s*mh\b/gi) || [];
  if (mhMatches.length > 0 && !specs.inductanceUH) specs.inductanceMH = parseFloat(mhMatches[0]);

  // Resistance - kOhm
  var kohMatches = lower.match(/(\d+(?:\.\d+)?)\s*k(?:ohm|ohms|\b)/gi) || [];
  if (kohMatches.length > 0) specs.resistanceKOhm = parseFloat(kohMatches[0]);

  // Resistance - Ohm
  var ohmMatches = lower.match(/(\d+(?:\.\d+)?)\s*(?:ohm|ohms|r\b)/gi) || [];
  if (ohmMatches.length > 0 && !specs.resistanceKOhm) specs.resistanceOhm = parseFloat(ohmMatches[0]);

  // GBW / Bandwidth - MHz
  var mhzMatches = lower.match(/(\d+(?:\.\d+)?)\s*mhz\b/gi) || [];
  if (mhzMatches.length > 0) {
    if (lower.includes("gbw") || lower.includes("gain bandwidth") || lower.includes("bandwidth")) {
      specs.gbwMHz = parseFloat(mhzMatches[0]);
    } else {
      specs.freqMHz = parseFloat(mhzMatches[0]);
    }
  }

  // Frequency - kHz
  var khzMatches = lower.match(/(\d+(?:\.\d+)?)\s*khz\b/gi) || [];
  if (khzMatches.length > 0 && !specs.freqMHz && !specs.gbwMHz) {
    if (lower.includes("switching") || lower.includes("fsw")) {
      specs.switchFreqKHz = parseFloat(khzMatches[0]);
    } else {
      specs.freqKHz = parseFloat(khzMatches[0]);
    }
  }

  // Noise - nV
  var nvMatches = lower.match(/(\d+(?:\.\d+)?)\s*nv\b/gi) || [];
  if (nvMatches.length > 0) specs.noiseNV = parseFloat(nvMatches[0]);

  // Dropout - mV
  var mvMatches = lower.match(/(\d+(?:\.\d+)?)\s*mv\b/gi) || [];
  if (mvMatches.length > 0 && (lower.includes("dropout") || lower.includes("ldo"))) {
    specs.dropoutMV = parseFloat(mvMatches[0]);
  }

  // Rds(on) max - mOhm
  var rdsMohm = lower.match(/(\d+(?:\.\d+)?)\s*m(?:ohm|ohms|\u03a9)\b/gi) || [];
  if (rdsMohm.length > 0 && (lower.includes("rds") || lower.includes("on resistance"))) {
    specs.rdsMax = parseFloat(rdsMohm[0]);
  }

  // Forward voltage - V (for diodes/LEDs)
  if (lower.includes("forward voltage") || lower.includes("vf") || lower.includes("led")) {
    if (specs.voltage && specs.voltage < 5) {
      specs.forwardV = specs.voltage;
      delete specs.voltage;
    }
  }

  // Slew rate - V/us
  var srMatches = lower.match(/(\d+(?:\.\d+)?)\s*v\/us\b/gi) || [];
  if (srMatches.length > 0) specs.slewRateVus = parseFloat(srMatches[0]);

  // Output voltage for regulators
  if (lower.includes("ldo") || lower.includes("regulator") || lower.includes("output voltage")) {
    var vout = lower.match(/(\d+(?:\.\d+)?)\s*v\s*output/gi) || lower.match(/output\s*(\d+(?:\.\d+)?)\s*v/gi) || [];
    if (vout.length > 0) specs.outputV = parseFloat(vout[0]);
  }

  console.log("Required specs from query:", JSON.stringify(specs));
  return specs;
}

// =============================================
// GET SPEC VALUE FROM PART KEYSPECS
// =============================================
function getSpecFromPart(part, labels) {
  var specs = part.keySpecs || [];
  if (!Array.isArray(specs)) return null;
  for (var i = 0; i < specs.length; i++) {
    var label = (specs[i].label || "").toLowerCase().trim();
    var value = parseFloat(specs[i].value);
    var unit = (specs[i].unit || "").toLowerCase().trim();
    if (isNaN(value)) continue;
    for (var j = 0; j < labels.length; j++) {
      if (label === labels[j] || label.indexOf(labels[j]) !== -1) {
        return { value: value, unit: unit };
      }
    }
  }
  return null;
}

// Convert spec value to base unit based on unit string
function toBaseUnit(specResult) {
  if (!specResult) return null;
  var v = specResult.value;
  var u = specResult.unit;
  if (u === "mv") return v / 1000;
  if (u === "kv") return v * 1000;
  if (u === "ma") return v / 1000;
  if (u === "ka") return v * 1000;
  if (u === "mw") return v / 1000;
  if (u === "kw") return v * 1000;
  if (u === "nh") return v / 1000;
  if (u === "mh") return v * 1000;
  if (u === "nf") return v / 1000;
  if (u === "mf") return v * 1000;
  if (u === "mohm" || u === "m\u03a9" || u === "milliohm") return v / 1000;
  if (u === "kohm" || u === "k\u03a9" || u === "k") return v * 1000;
  if (u === "mohm-large" || u === "megaohm") return v * 1000000;
  if (u === "khz") return v * 1000;
  if (u === "mhz") return v * 1000000;
  if (u === "ghz") return v * 1000000000;
  return v;
}

// =============================================
// UNIVERSAL SPEC VALIDATOR
// Rejects parts that fail to meet requirements
// Works for all component types
// =============================================
function validateSpecs(parts, requiredSpecs) {
  if (!parts || parts.length === 0) return parts;
  if (!requiredSpecs || Object.keys(requiredSpecs).length === 0) return parts;

  var filtered = parts.filter(function(part) {
    var passed = true;
    var rejectionReason = "";

    for (var di = 0; di < SPEC_DEFINITIONS.length; di++) {
      var def = SPEC_DEFINITIONS[di];
      var reqVal = requiredSpecs[def.reqKey];
      if (reqVal === undefined || reqVal === null) continue;

      // Convert required value to base unit using scale
      var reqBase = def.scale ? reqVal * def.scale : reqVal;

      var partSpec = getSpecFromPart(part, def.labels);
      if (!partSpec) continue;

      var partBase = toBaseUnit(partSpec);
      if (partBase === null) continue;

      // Apply scale if defined (e.g. currentMA reqKey looks at same labels as current)
      if (def.scale) partBase = partBase; // already in base unit from toBaseUnit

      if (def.direction === "min") {
        // Part must meet or exceed required value (5% tolerance)
        if (partBase < reqBase * 0.95) {
          passed = false;
          rejectionReason = def.reqKey + " " + partBase + " < required " + reqBase;
        }
      } else if (def.direction === "max") {
        // Part must be equal or lower than required (lower is better)
        if (partBase > reqBase * 1.05) {
          passed = false;
          rejectionReason = def.reqKey + " " + partBase + " > max " + reqBase;
        }
      } else if (def.direction === "exact") {
        // Part must be within tolerance of required value
        var tol = def.tolerance || 0.20;
        if (Math.abs(partBase - reqBase) / reqBase > tol) {
          passed = false;
          rejectionReason = def.reqKey + " " + partBase + " != " + reqBase + " (tol " + (tol * 100) + "%)";
        }
      }

      if (!passed) break;
    }

    if (!passed) console.log("  REJECTED", part.partNumber, "-", rejectionReason);
    return passed;
  });

  // Only use filtered if we kept at least 2 parts, otherwise return all
  if (filtered.length >= 2) {
    console.log("Spec validation: kept " + filtered.length + "/" + parts.length);
    return filtered;
  }
  console.log("Spec validation: not enough valid parts, keeping all");
  return parts;
}

// =============================================
// UNIVERSAL CLOSENESS SCORER
// Ranks parts by how close they are to requested specs
// Works for all component types
// =============================================
function scoreCloseness(part, requiredSpecs) {
  var totalScore = 0;
  var specCount = 0;

  for (var di = 0; di < SPEC_DEFINITIONS.length; di++) {
    var def = SPEC_DEFINITIONS[di];
    if (!def.primary) continue; // only score primary specs

    var reqVal = requiredSpecs[def.reqKey];
    if (reqVal === undefined || reqVal === null) continue;

    var reqBase = def.scale ? reqVal * def.scale : reqVal;
    var partSpec = getSpecFromPart(part, def.labels);
    if (!partSpec) continue;

    var partBase = toBaseUnit(partSpec);
    if (partBase === null || reqBase === 0) continue;

    // Score = how close is the part to the required value
    // Score of 0 = perfect match, higher = further away
    var ratio;
    if (def.direction === "min") {
      // For min specs (voltage, current, GBW): prefer closest value above requirement
      // Part at exactly required = perfect (score 0)
      // Part 2x over = score 1.0 (penalty for being too over-rated)
      ratio = (partBase - reqBase) / reqBase;
      if (ratio < 0) ratio = 10; // below requirement = bad score
    } else if (def.direction === "max") {
      // For max specs (noise, dropout, Rds): prefer closest value below requirement
      ratio = (reqBase - partBase) / reqBase;
      if (ratio < 0) ratio = 10; // above max = bad
    } else {
      // For exact specs (capacitance, inductance): prefer closest match
      ratio = Math.abs(partBase - reqBase) / reqBase;
    }

    totalScore += ratio;
    specCount++;
  }

  return specCount > 0 ? totalScore / specCount : 999;
}

// =============================================
// SORT PARTS: in-stock first, then closest spec match
// =============================================
function sortParts(parts, stockData, requiredSpecs) {
  return parts.slice().sort(function(a, b) {
    var sa = stockData[a.partNumber] ? stockData[a.partNumber].totalStock : 0;
    var sb = stockData[b.partNumber] ? stockData[b.partNumber].totalStock : 0;

    // First: in stock vs out of stock
    var aIn = sa > 0 ? 1 : 0;
    var bIn = sb > 0 ? 1 : 0;
    if (bIn !== aIn) return bIn - aIn;

    // Second: closeness to requested specs
    if (Object.keys(requiredSpecs).length > 0) {
      var aScore = scoreCloseness(a, requiredSpecs);
      var bScore = scoreCloseness(b, requiredSpecs);
      var scoreDiff = aScore - bScore;
      if (Math.abs(scoreDiff) > 0.05) return scoreDiff;
    }

    // Third: stock quantity
    return sb - sa;
  });
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
var INTENT_SYSTEM = "You classify hardware engineering queries. Consider the full conversation context. If the new message is a follow-up refinement (like 'only in stock', 'cheaper', 'different package', 'find alternatives for that'), classify it as the SAME intent as the previous turn.\n\nCRITICAL: Any message asking for a component, part, chip, MOSFET, op-amp, capacitor, inductor, resistor, diode, regulator, sensor, IC, or any electronic part MUST be classified as part_search. Never classify component requests as circuit_question or general.\n\nExamples that MUST be part_search:\n- 'I need a 100V 30A MOSFET'\n- 'find me a low noise op-amp'\n- 'suggest a 10uH inductor for buck converter'\n- '3.3V LDO regulator 500mA'\n- 'what MOSFET should I use for motor drive'\n\nRespond ONLY with JSON:\n{\"intent\":\"part_search|find_alternatives|generate_bom|circuit_question|calculation|correction|general\",\"partNumber\":\"extracted part number or null\",\"needsMoreInfo\":false,\"followUpQuestion\":null}\n\nIntent rules:\n- part_search = any request for a specific type of component or part\n- find_alternatives = replacement for a specific named part number\n- generate_bom = user describes a full system and wants a complete BOM\n- circuit_question = topology, theory, how does X work (no part needed)\n- calculation = numerical formula or calculation only\n- correction = user fixing previous answer\n- general = non-electronics question\n\nSet needsMoreInfo true ONLY if absolutely nothing is known about what the user wants.";

var ENGINEERING_SYSTEM = "You are PartTensor, a senior hardware application engineer AI. Help engineers with component selection, circuit design, calculations, and troubleshooting. Be direct, technical and precise. Use real part numbers and formulas. Format with **bold headers** and - bullet points. Keep answers focused and practical.";

var SEARCH_SYSTEM = "You are a senior application engineer finding electronic components.\nCRITICAL RULES:\n1. Find the CLOSEST MATCH to the requested specs. If user asks 100V, prefer 100-120V parts over 200V parts. If user asks 30A, prefer 30-40A over 100A. Over-rated parts rank lower.\n2. NEVER suggest parts below the requested minimum. If user asks 100V never suggest 60V or 80V.\n3. For capacitors: find parts with capacitance closest to requested value.\n4. For inductors: find parts with inductance closest to requested value.\n5. For op-amps: find parts with GBW closest to or exceeding requested value. Lower noise is better.\n6. For LDOs: find parts with dropout voltage closest to or below requested. Output voltage must match.\n7. For diodes: forward voltage must match. Reverse voltage must meet or exceed.\n8. For resistors: value must match within 1%/5%/10% as requested.\n9. Include the PRIMARY requested spec as the FIRST keySpec entry.\n10. Suggest EXACTLY 4 results from 4 DIFFERENT manufacturers. rank: first=top (closest match in stock), second=good, third/fourth=alternative.\n11. Use real Digi-Key part numbers. Manufacturers: Infineon, Vishay, ON Semi, TI, STMicro, Analog Devices, Microchip, Renesas, Rohm, Nexperia, Murata, Wurth, Panasonic, Kemet, Taiyo Yuden, EPCOS.\nRespond ONLY with raw JSON starting with {:\n{\"mode\":\"search\",\"category\":\"N-Channel MOSFET\",\"interpretation\":\"one sentence\",\"results\":[{\"partNumber\":\"IRF540NPBF\",\"manufacturer\":\"Vishay\",\"type\":\"N-Channel MOSFET\",\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"100\",\"unit\":\"V\"},{\"label\":\"ID\",\"value\":\"33\",\"unit\":\"A\"},{\"label\":\"RDS(on)\",\"value\":\"44\",\"unit\":\"m\\u03a9\"},{\"label\":\"Qg\",\"value\":\"71\",\"unit\":\"nC\"},{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],\"package\":\"TO-220\",\"applications\":[\"Motor Drive\"],\"rank\":\"top\",\"aeComment\":\"Closest match to 100V/30A. Good for motor drive.\",\"caution\":null}],\"designTip\":\"one practical tip\"}";

var BOM_SYSTEM = "You are a senior hardware application engineer. Generate a smart Bill of Materials. Only critical components: MOSFETs, ICs, drivers, specialized inductors, electrolytic caps, current sense resistors, crystals, connectors, optocouplers, diodes, sensors. NO generic resistors, 100nF caps, generic LEDs. Full Digi-Key part numbers. 5 keySpecs per part. All parts must meet the application specs.\nRespond ONLY with raw JSON starting with {:\n{\"bomItems\":[{\"id\":1,\"function\":\"Gate Driver\",\"partNumber\":\"IR2184SPBF\",\"manufacturer\":\"Infineon\",\"description\":\"one line\",\"category\":\"IC\",\"quantity\":1,\"keySpecs\":\"600V 2A SO-8\",\"package\":\"SO-8\",\"priority\":\"critical\",\"unitPrice\":\"$1.20\",\"notes\":null}],\"projectName\":\"name\",\"description\":\"sentence\",\"voltage\":\"V\",\"power\":\"W\",\"designNotes\":\"notes\",\"totalEstimate\":\"$15-25\"}";

function buildAltSystem(originalPart) {
  var specs = originalPart.specs || {};
  var specLines = [];
  if (specs.voltage) specLines.push("Voltage >= " + specs.voltage + "V");
  if (specs.current) specLines.push("Current >= " + specs.current + "A");
  if (specs.resistance) specLines.push("Rds/Ron <= " + specs.resistance);
  if (specs.power) specLines.push("Power >= " + specs.power + "W");
  if (specLines.length === 0) specLines.push("Match: " + originalPart.specsText.substring(0, 150));
  return "Find EXACTLY 4 alternatives from 4 DIFFERENT manufacturers for: " + originalPart.mpn + " by " + originalPart.manufacturer + " — " + originalPart.description + "\nREQUIRED SPECS (real DigiKey data): " + specLines.join(", ") + "\nAll must meet or exceed specs. Real Digi-Key parts only. Different manufacturers than " + originalPart.manufacturer + ". Sort by best drop-in compatibility first.\nRespond ONLY with raw JSON starting with {:\n{\"mode\":\"alt\",\"originalPart\":\"" + originalPart.mpn + "\",\"originalSpecs\":\"" + specLines.join(", ") + "\",\"alternatives\":[{\"partNumber\":\"IRFB4115GPBF\",\"manufacturer\":\"Vishay\",\"type\":\"N-Channel MOSFET\",\"compatibility\":\"drop-in\",\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"150\",\"unit\":\"V\"},{\"label\":\"ID\",\"value\":\"104\",\"unit\":\"A\"},{\"label\":\"RDS(on)\",\"value\":\"11\",\"unit\":\"m\\u03a9\"},{\"label\":\"Qg\",\"value\":\"120\",\"unit\":\"nC\"},{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],\"package\":\"TO-220\",\"whyAlternative\":\"reason\",\"differences\":\"key differences\"}],\"importantNote\":\"note\"}";
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

    // Extract required specs from message
    var requiredSpecs = extractRequiredSpecs(message);

    // CLASSIFY INTENT WITH HISTORY CONTEXT
    var contextSummary = history.slice(-6).map(function(m) {
      return (m.role === "user" ? "User: " : "AI: ") + (m.content || "").substring(0, 150);
    }).join("\n");
    var intentInput = history.length > 0 ? "Previous conversation:\n" + contextSummary + "\n\nNew message: " + message : message;
    var intentResult = await callAI(INTENT_SYSTEM, [{ role: "user", content: intentInput }], 300);
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
    console.log("Intent:", intent, "| PN:", detectedPN, "| Specs:", JSON.stringify(requiredSpecs));

    if (needsMoreInfo && followUpQuestion && !isCorrection) {
      return res.json({ text: followUpQuestion, intent: intent, mode: "question" });
    }

    var fullMessages = [];
    var historySlice = history.slice(-8);
    for (var i = 0; i < historySlice.length; i++) {
      if (historySlice[i].content) fullMessages.push({ role: historySlice[i].role, content: historySlice[i].content });
    }
    fullMessages.push({ role: "user", content: message });

    // CIRCUIT / CALCULATION / GENERAL / CORRECTION
    if (intent === "circuit_question" || intent === "calculation" || intent === "general" || intent === "correction") {
      var engSystem = ENGINEERING_SYSTEM;
      if (isCorrection) engSystem += "\n\nThe user is correcting a previous response. Address their feedback directly.";
      var engResult = await callAI(engSystem, fullMessages, 2000);
      if (engResult.error) return res.status(503).json({ error: engResult.error });
      return res.json({ text: engResult.text, intent: intent, mode: "text" });
    }

    // FIND ALTERNATIVES
    if (intent === "find_alternatives") {
      var pn = detectedPN || extractPartNumber(message);
      if (!pn) return res.json({ text: "Could you specify the part number you want alternatives for?", intent: intent, mode: "question" });
      console.log("Fetching specs for:", pn);
      var originalPart = await fetchPartSpecs(pn);
      if (!originalPart) {
        var fbAlt = await callAI(SEARCH_SYSTEM, fullMessages, 3000);
        var fbParsed = fbAlt.text ? extractJSON(fbAlt.text) : null;
        if (!fbParsed) return res.json({ text: "Could not find specs for " + pn + ". Please provide the key specs to match.", intent: intent, mode: "question" });
        var fbParts = fbParsed.alternatives || fbParsed.results || [];
        fbParts = validateSpecs(fbParts, requiredSpecs);
        var fbStock = await prefetchStock(fbParts.map(function(p) { return p.partNumber; }));
        fbParsed.stockData = fbStock;
        fbParsed.mode = "alt";
        return res.json(Object.assign({ text: "Here are alternatives for **" + pn + "**:", intent: intent }, fbParsed));
      }
      if (originalPart.isPassive) {
        return res.json({
          text: "For **" + pn + "** (" + originalPart.categoryName + "), parametric search gives the most accurate alternatives.",
          mode: "passive_connector_alt", originalPart: pn, originalManufacturer: originalPart.manufacturer,
          originalDescription: originalPart.description, categoryName: originalPart.categoryName,
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
      if (!altData) return res.json({ text: "Had trouble finding alternatives for " + pn + ". Please try again.", intent: intent, mode: "text" });
      var altParts = altData.alternatives || [];
      altParts = validateSpecs(altParts, originalPart.specs);
      var altStock = await prefetchStock(altParts.map(function(p) { return p.partNumber; }));
      altParts = sortParts(altParts, altStock, originalPart.specs);
      altData.alternatives = altParts;
      altData.stockData = altStock;
      altData.mode = "alt";
      return res.json(Object.assign({ text: "Here are **" + altParts.length + " alternatives** for **" + pn + "**, all meeting or exceeding its specs:", intent: intent }, altData));
    }

    // GENERATE BOM
    if (intent === "generate_bom") {
      var bomCacheKey = "bom:" + message.toLowerCase().trim();
      var cachedBOM = getCached(aiCache, bomCacheKey);
      if (cachedBOM) { console.log("BOM cache hit"); return res.json(cachedBOM); }
      var bomResult = await callAI(BOM_SYSTEM, fullMessages, 4000);
      var bomData = bomResult.text ? extractJSON(bomResult.text) : null;
      if (!bomData || !bomData.bomItems) return res.json({ text: "Had trouble generating the BOM. Could you describe the application in more detail?", intent: intent, mode: "question" });
      var bomParts = bomData.bomItems.map(function(p) { return p.partNumber; });
      var bomStock = await prefetchStock(bomParts);
      bomData.stockData = bomStock;
      bomData.bomItems = sortParts(bomData.bomItems, bomStock, {});
      var bomText = "Here is a **sourcing-ready BOM** for your **" + bomData.projectName + "** — " + bomData.bomItems.length + " critical components:";
      var bomResponse = Object.assign({ text: bomText, intent: intent }, bomData);
      setCache(aiCache, bomCacheKey, bomResponse, AI_TTL);
      return res.json(bomResponse);
    }

    // PART SEARCH (default)
    var hasSpecs = Object.keys(requiredSpecs).length > 0;
    var searchCacheKey = "search:" + message.toLowerCase().trim();
    if (!hasSpecs) {
      var cachedSearch = getCached(aiCache, searchCacheKey);
      if (cachedSearch) { console.log("Search cache hit"); return res.json(cachedSearch); }
    }

    var searchResult = await callAI(SEARCH_SYSTEM, fullMessages, 4000);
    var searchData = searchResult.text ? extractJSON(searchResult.text) : null;
    if (!searchData || !searchData.results) {
      var fallbackEng = await callAI(ENGINEERING_SYSTEM, fullMessages, 1500);
      return res.json({ text: fallbackEng.text || "Could not find specific parts. Could you provide more details?", intent: intent, mode: "text" });
    }

    // Validate specs then sort by closeness + stock
    searchData.results = validateSpecs(searchData.results, requiredSpecs);
    var searchParts = searchData.results.map(function(p) { return p.partNumber; });
    var searchStock = await prefetchStock(searchParts);
    searchData.stockData = searchStock;
    searchData.mode = "search";
    searchData.results = sortParts(searchData.results, searchStock, requiredSpecs);

    var searchText = "Found **" + searchData.results.length + " options** — " + (searchData.interpretation || "") + ". Best match first:";
    var searchResponse = Object.assign({ text: searchText, intent: intent }, searchData);
    if (!hasSpecs) setCache(aiCache, searchCacheKey, searchResponse, AI_TTL);
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
    if (partNumbers.length === 0) return res.status(400).json({ error: "No part numbers found." });
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
