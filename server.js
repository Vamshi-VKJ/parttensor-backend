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
      var r2 = { found: true, stock: best2.QuantityAvailable || 0, price: p2 ? "$" + parseFloat(p2).toFixed(3) : null, url: best2.ProductUrl || "", matchedMPN: best2.ManufacturerProductNumber || mpn };
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
// VALIDATE AND ENRICH PARTS WITH DIGIKEY DATA
// This is the key validation layer
// =============================================
async function validateAndEnrichParts(parts, requiredSpecs) {
  if (!parts || parts.length === 0) return parts;
  console.log("Validating", parts.length, "parts against DigiKey real data...");
  var validated = [];
  var rejected = [];

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    var dkResult = await lookupDigikey(part.partNumber);

    // Part not found on DigiKey at all
    if (!dkResult) {
      console.log("  NOT FOUND on DigiKey:", part.partNumber);
      rejected.push({ partNumber: part.partNumber, reason: "not found on DigiKey" });
      continue;
    }

    // Update to exact DigiKey MPN
    if (dkResult.matchedMPN && dkResult.matchedMPN !== part.partNumber) {
      console.log("  MPN corrected:", part.partNumber, "->", dkResult.matchedMPN);
      part.partNumber = dkResult.matchedMPN;
    }

    // Extract real specs from DigiKey parameters
    var params = dkResult.parameters || [];
    var realSpecs = {};
    for (var j = 0; j < params.length; j++) {
      var param = params[j];
      var name = (param.Parameter || "").toLowerCase();
      var val = parseFloat(param.Value);
      if (!isNaN(val)) {
        if (name === "vds" || name === "vce" || name === "vrrm" || (name.includes("voltage") && !name.includes("threshold") && !name.includes("gate"))) {
          if (!realSpecs.voltage) realSpecs.voltage = val;
        }
        if (name === "id" || name === "ic" || name === "iout" || name === "if" || (name.includes("current") && name.includes("continuous"))) {
          if (!realSpecs.current) realSpecs.current = val;
        }
        if (name.includes("rds") || name.includes("r_ds")) realSpecs.rdsOn = val;
        if (name.includes("capacitance")) realSpecs.capacitance = val;
        if (name.includes("inductance")) realSpecs.inductance = val;
        if (name.includes("coil") && name.includes("volt")) realSpecs.coilVoltage = val;
        if (name.includes("contact") && name.includes("current")) realSpecs.contactCurrent = val;
      }
    }

    // Validate against required specs from user query
    var specIssues = [];
    if (requiredSpecs.voltage && realSpecs.voltage && realSpecs.voltage < requiredSpecs.voltage * 0.95) {
      specIssues.push("Voltage " + realSpecs.voltage + "V < required " + requiredSpecs.voltage + "V");
    }
    if (requiredSpecs.current && realSpecs.current && realSpecs.current < requiredSpecs.current * 0.95) {
      specIssues.push("Current " + realSpecs.current + "A < required " + requiredSpecs.current + "A");
    }

    if (specIssues.length > 0) {
      console.log("  SPEC MISMATCH:", part.partNumber, specIssues.join(", "));
      rejected.push({ partNumber: part.partNumber, reason: specIssues.join(", ") });
      continue;
    }

    // Update keySpecs with verified DigiKey values where available
    if (realSpecs.voltage && part.keySpecs && part.keySpecs.length > 0) {
      for (var k = 0; k < part.keySpecs.length; k++) {
        var label = (part.keySpecs[k].label || "").toLowerCase();
        if ((label === "vds" || label === "vce" || label === "vrrm") && realSpecs.voltage) {
          part.keySpecs[k].value = String(realSpecs.voltage);
        }
        if ((label === "id" || label === "ic" || label === "iout") && realSpecs.current) {
          part.keySpecs[k].value = String(realSpecs.current);
        }
        if (label.includes("rds") && realSpecs.rdsOn) {
          part.keySpecs[k].value = String(realSpecs.rdsOn);
        }
      }
    }

    part._dkStock = dkResult.stock;
    part._validated = true;
    console.log("  VALIDATED:", part.partNumber, "stock:", dkResult.stock);
    validated.push(part);
  }

  console.log("Validation: " + validated.length + " passed, " + rejected.length + " rejected");

  // If all rejected return originals with a warning
  if (validated.length === 0) {
    console.log("All parts rejected - returning originals without validation");
    return parts;
  }

  return validated;
}

// =============================================
// CLAUDE AI
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
  var maM = lower.match(/(\d+(?:\.\d+)?)\s*ma\b/gi) || [];
  if (maM.length > 0 && !specs.current) { var mas = maM.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v); }); if (mas.length > 0) specs.currentMA = Math.max.apply(null, mas); }
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

var COMPONENT_KEYWORDS = ["relay", "mosfet", "capacitor", "resistor", "inductor", "diode", "transistor", "op-amp", "opamp", "ldo", "regulator", "sensor", "connector", "switch", "fuse", "crystal", "oscillator", "driver", "controller", "igbt", "thyristor", "triac", "optocoupler", "transformer", "ic", "chip", "bjt", "scr", "module", "rectifier", "varistor", "thermistor", "potentiometer", "encoder", "solenoid", "motor driver", "gate driver", "voltage reference", "comparator", "adc", "dac", "mux", "buffer", "schottky", "zener", "fet"];

function isComponentQuery(message) {
  var lower = message.toLowerCase();
  for (var i = 0; i < COMPONENT_KEYWORDS.length; i++) {
    if (lower.includes(COMPONENT_KEYWORDS[i])) return true;
  }
  return false;
}

// =============================================
// SYSTEM PROMPTS
// =============================================
var INTENT_SYSTEM = "You classify hardware engineering queries into exactly one intent. RULES:\n1. ANY message mentioning a component name or asking to find/recommend/suggest a part MUST be 'part_search'. This includes: relay, MOSFET, capacitor, resistor, inductor, diode, transistor, op-amp, LDO, regulator, sensor, connector, switch, fuse, crystal, oscillator, driver, controller, IGBT, optocoupler, transformer, IC, chip, BJT, module, rectifier.\n2. Only 'circuit_question' if asking HOW something works with NO component request.\n3. Only 'calculation' if asking to calculate a value with NO component request.\n4. Only 'general' if completely unrelated to electronics.\n5. Follow-up refinements keep SAME intent as previous turn.\nRespond ONLY with JSON: {\"intent\":\"part_search|find_alternatives|generate_bom|circuit_question|calculation|correction|general\",\"partNumber\":null,\"needsMoreInfo\":false,\"followUpQuestion\":null}";

var ENGINEERING_SYSTEM = "You are PartTensor, a senior hardware application engineer AI. Help engineers with component selection, circuit design, calculations, and troubleshooting. Be direct, technical and precise. Format with **bold headers** and - bullet points. Keep answers focused and practical.";

// Strict part search prompt - Claude must verify specs before suggesting
var PART_SEARCH_SYSTEM = "You are a senior hardware application engineer with deep knowledge of electronic components. Your task is to suggest EXACTLY 4 real electronic parts that PRECISELY match the user's requirements.\n\nSTRICT RULES - FOLLOW EXACTLY:\n1. VERIFY each part number against your training knowledge before including it.\n2. For VOLTAGE specs: part voltage rating MUST be >= requested voltage. If user asks 100V, ONLY suggest parts rated 100V or higher. NEVER suggest a 60V part for a 100V application.\n3. For CURRENT specs: part current rating MUST be >= requested current. If user asks 10A, ONLY suggest parts rated 10A or higher.\n4. For RELAYS: match coil voltage EXACTLY. If user asks 12V relay, ONLY suggest 12V coil relays. Match contact rating >= requested current.\n5. For CAPACITORS: value must be within 20% of requested value.\n6. For INDUCTORS: value must be within 20% of requested value.\n7. Prefer parts CLOSE to the requirement, not massively oversized. For 100V 10A, prefer 100V 12A over 600V 100A.\n8. ONLY use manufacturers: Infineon, Vishay, ON Semi, TI, STMicro, Rohm, Renesas, Nexperia, Microchip, Murata, Wurth, Panasonic, Kemet, Omron, TE Connectivity, Panasonic, Finder, Phoenix Contact, Bourns, Yageo, Susumu, Coilcraft, Eaton, Taiyo Yuden.\n9. ONLY suggest parts that ACTUALLY EXIST on DigiKey right now.\n10. Include 4 keySpecs - first spec MUST be the main rating (voltage/capacitance/inductance/coil voltage).\n\nSELF-CHECK before responding: For EACH part ask yourself:\n- Does this part number actually exist? Yes/No\n- Does it meet the voltage requirement? Yes/No\n- Does it meet the current requirement? Yes/No\n- Is it available on DigiKey? Yes/No\nIf any answer is No, REPLACE that part with a correct one.\n\nRespond ONLY with raw JSON starting with {:\n{\"category\":\"N-Channel MOSFET\",\"interpretation\":\"brief summary of what user needs\",\"designTip\":\"one practical tip\",\"results\":[{\"partNumber\":\"IRF540NPBF\",\"manufacturer\":\"Vishay\",\"type\":\"N-Channel MOSFET\",\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"100\",\"unit\":\"V\"},{\"label\":\"ID\",\"value\":\"33\",\"unit\":\"A\"},{\"label\":\"RDS(on)\",\"value\":\"44\",\"unit\":\"mOhm\"},{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],\"package\":\"TO-220\",\"rank\":\"top\",\"aeComment\":\"100V/33A meets requirements exactly. Popular in motor drives with proven reliability.\",\"caution\":null,\"applications\":[\"Motor Drive\",\"Power Switching\"]}]}";

var ALT_SEARCH_SYSTEM = "You are a senior hardware application engineer. Find EXACTLY 4 drop-in alternative parts for the given part number. Rules:\n1. All alternatives MUST meet or exceed the original part's specs.\n2. Use DIFFERENT manufacturers than the original.\n3. Only suggest parts that ACTUALLY EXIST on DigiKey.\n4. Sort by best compatibility first.\n5. Include 4 keySpecs per part.\nRespond ONLY with raw JSON:\n{\"originalPart\":\"MPN\",\"originalSpecs\":\"100V 33A TO-220\",\"alternatives\":[{\"partNumber\":\"MPN\",\"manufacturer\":\"Mfr\",\"type\":\"Type\",\"compatibility\":\"drop-in\",\"keySpecs\":[{\"label\":\"L\",\"value\":\"V\",\"unit\":\"U\"}],\"package\":\"PKG\",\"whyAlternative\":\"reason\",\"differences\":\"differences\"}],\"importantNote\":\"note\"}";

var BOM_SYSTEM = "You are a senior hardware application engineer. Generate a complete Bill of Materials for the described system. Include ALL critical components: power semiconductors, gate drivers, control ICs, voltage regulators, current sensors, bulk capacitors, power inductors, optocouplers, crystals, connectors. NO generic bypass caps or pull-up resistors unless critical. Use exact DigiKey part numbers. Include 4 keySpecs per part.\nRespond ONLY with raw JSON:\n{\"projectName\":\"name\",\"description\":\"sentence\",\"voltage\":\"V\",\"power\":\"W\",\"designNotes\":\"notes\",\"totalEstimate\":\"$X-Y\",\"bomItems\":[{\"id\":1,\"function\":\"High Side Gate Driver\",\"partNumber\":\"IR2184SPBF\",\"manufacturer\":\"Infineon\",\"description\":\"600V Half Bridge Gate Driver\",\"category\":\"IC\",\"quantity\":2,\"keySpecs\":\"600V 2A 200ns SO-8\",\"package\":\"SO-8\",\"priority\":\"critical\",\"unitPrice\":\"$1.20\",\"notes\":null}]}";

// =============================================
// HEALTH
// =============================================
app.get("/api/health", function(req, res) {
  res.json({ status: "ok", service: "PartTensor", time: new Date().toISOString() });
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
    var partNumber = req.body.partNumber;
    var feedback = req.body.feedback;
    var query = req.body.query;
    var componentType = req.body.componentType;
    var manufacturer = req.body.manufacturer;
    if (!partNumber || !feedback) return res.status(400).json({ error: "Required fields missing" });
    var score = feedback === "good" ? 5 : -10;
    var queryNorm = (query || "").toLowerCase().trim().replace(/\s+/g, " ");
    var existing = await supabaseQuery("GET", "part_performance", null, "query_normalized=eq." + encodeURIComponent(queryNorm) + "&part_number=eq." + encodeURIComponent(partNumber) + "&select=id,total_score,negative_feedback");
    if (existing && existing.length > 0) {
      var updates = { total_score: (existing[0].total_score || 0) + score, last_updated: new Date().toISOString() };
      if (feedback === "bad") updates.negative_feedback = (existing[0].negative_feedback || 0) + 1;
      await supabaseQuery("PATCH", "part_performance", updates, "id=eq." + existing[0].id);
    } else {
      await supabaseQuery("POST", "part_performance", { query_normalized: queryNorm, component_type: componentType || "", part_number: partNumber, manufacturer: manufacturer || "", total_score: score, negative_feedback: feedback === "bad" ? 1 : 0, buy_clicks: 0, datasheet_clicks: 0, card_clicks: 0, alternative_searches: 0, last_updated: new Date().toISOString() });
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
    var amounts = { monthly: 9900, yearly: 79900 };
    var Razorpay = require("razorpay");
    var rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    var order = await rzp.orders.create({ amount: amounts[plan] || 9900, currency: "INR", receipt: "pt_" + Date.now(), notes: { userId: req.body.userId || "", plan: plan } });
    res.json({ orderId: order.id, amount: amounts[plan] || 9900, currency: "INR", plan: plan });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/verify-payment", async function(req, res) {
  try {
    var crypto = require("crypto");
    var expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "").update(req.body.razorpay_order_id + "|" + req.body.razorpay_payment_id).digest("hex");
    if (expected !== req.body.razorpay_signature) return res.status(400).json({ error: "Verification failed" });
    var userId = req.body.userId;
    var plan = req.body.plan || "monthly";
    var expiresAt = new Date();
    if (plan === "yearly") expiresAt.setFullYear(expiresAt.getFullYear() + 1); else expiresAt.setMonth(expiresAt.getMonth() + 1);
    if (userId) {
      var ex = await supabaseQuery("GET", "usage_limits", null, "identifier=eq." + encodeURIComponent(userId) + "&select=id");
      if (ex && ex.length > 0) await supabaseQuery("PATCH", "usage_limits", { plan: "paid", message_count: 0, last_reset: new Date().toISOString().split("T")[0] }, "id=eq." + ex[0].id);
      else await supabaseQuery("POST", "usage_limits", { identifier: userId, identifier_type: "user", message_count: 0, last_reset: new Date().toISOString().split("T")[0], plan: "paid" });
      await supabaseQuery("POST", "payments", { user_id: userId, plan: plan, status: "active", razorpay_payment_id: req.body.razorpay_payment_id, razorpay_order_id: req.body.razorpay_order_id, expires_at: expiresAt.toISOString() });
    }
    res.json({ success: true, plan: plan });
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
    var plan = req.body.plan || "guest";
    if (!message) return res.status(400).json({ error: "Message is required" });
    console.log("\n[CHAT]", message.substring(0, 80));

    // USAGE LIMITS
    var GUEST_LIMIT = 10, FREE_LIMIT = 50;
    var identifier = userId || (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown");
    if (plan !== "paid") {
      try {
        var today = new Date().toISOString().split("T")[0];
        var usageRes = await supabaseQuery("GET", "usage_limits", null, "identifier=eq." + encodeURIComponent(identifier) + "&select=id,message_count,last_reset,plan");
        var usage = usageRes && usageRes[0];
        if (usage) {
          if (usage.last_reset !== today) {
            await supabaseQuery("PATCH", "usage_limits", { message_count: 1, last_reset: today }, "id=eq." + usage.id);
          } else {
            var count = (usage.message_count || 0) + 1;
            var lim = userId ? FREE_LIMIT : GUEST_LIMIT;
            if (count > lim) return res.json({ error: "Daily limit reached", limitReached: true });
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
    var intent = "part_search";
    var detectedPN = null;
    if (intentResult.text) {
      var ip = extractJSON(intentResult.text);
      if (ip) { intent = ip.intent || "part_search"; detectedPN = ip.partNumber || null; }
    }
    if (isComponentQuery(message) && intent === "general") intent = "part_search";
    console.log("Intent:", intent, "Component:", componentType, "Specs:", JSON.stringify(requiredSpecs));

    // Block non-electronics
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
      // Validate alternatives
      altParts = await validateAndEnrichParts(altParts, {});
      var altStockResults = await Promise.all(altParts.map(function(p) { return fetchStock(p.partNumber); }));
      var altStockMap = {};
      altParts.forEach(function(p, i) { altStockMap[p.partNumber] = altStockResults[i]; });
      altParts.sort(function(a, b) {
        var aS = altStockMap[a.partNumber] ? altStockMap[a.partNumber].totalStock : 0;
        var bS = altStockMap[b.partNumber] ? altStockMap[b.partNumber].totalStock : 0;
        return (bS > 0 ? 1 : 0) - (aS > 0 ? 1 : 0) || bS - aS;
      });
      return res.json({ text: "Here are **" + altParts.length + " alternatives** for **" + pn + "** validated against DigiKey:", mode: "alt", originalPart: altData.originalPart || pn, originalSpecs: altData.originalSpecs || "", alternatives: altParts, stockData: altStockMap, importantNote: altData.importantNote || null, intent: intent, query: message, componentType: componentType, requiredVoltage: requiredSpecs.voltage || null, requiredCurrent: requiredSpecs.current || null });
    }

    // GENERATE BOM
    if (intent === "generate_bom") {
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

    // PART SEARCH - Claude + DigiKey validation
    var searchCacheKey = "search_" + message.toLowerCase().trim().substring(0, 80);
    var searchCached = getCached(aiCache, searchCacheKey);
    var parts = null;
    var searchMeta = {};

    if (searchCached) {
      console.log("Cache hit");
      parts = searchCached.results || [];
      searchMeta = { category: searchCached.category, interpretation: searchCached.interpretation, designTip: searchCached.designTip };
    } else {
      // Step 1: Claude suggests parts with strict prompt
      console.log("Claude part search...");
      var searchResult = await callClaude(PART_SEARCH_SYSTEM, fullMessages, 3000);
      var searchData = searchResult.text ? extractJSON(searchResult.text) : null;

      if (!searchData || !searchData.results) {
        var fallback = await callClaude(ENGINEERING_SYSTEM, fullMessages, 1500);
        return res.json({ text: fallback.text || "Could not find specific parts. Please provide more details.", intent: intent, mode: "text" });
      }

      parts = searchData.results || [];
      searchMeta = { category: searchData.category || "", interpretation: searchData.interpretation || "", designTip: searchData.designTip || "" };
      console.log("Claude suggested:", parts.map(function(p) { return p.partNumber; }).join(", "));

      // Step 2: Validate all parts against DigiKey real data
      parts = await validateAndEnrichParts(parts, requiredSpecs);

      // Step 3: If validation left us with < 2 parts, retry Claude with stricter prompt
      if (parts.length < 2) {
        console.log("Too few parts after validation, retrying Claude...");
        var retryPrompt = message + ". IMPORTANT: The following parts were rejected because they do not exist on DigiKey or do not meet specs. Suggest DIFFERENT parts that definitely exist: " + (searchData.results || []).map(function(p) { return p.partNumber; }).join(", ");
        var retryResult = await callClaude(PART_SEARCH_SYSTEM, [{ role: "user", content: retryPrompt }], 3000);
        var retryData = retryResult.text ? extractJSON(retryResult.text) : null;
        if (retryData && retryData.results) {
          var retryValidated = await validateAndEnrichParts(retryData.results, requiredSpecs);
          if (retryValidated.length > parts.length) parts = retryValidated;
        }
      }

      setCache(aiCache, searchCacheKey, Object.assign({ results: parts }, searchMeta), AI_TTL);
    }

    // Apply learned ranking
    var learnedData = await getLearnedRankings(message, componentType);
    if (learnedData.length > 0) parts = applyLearnedRanking(parts, learnedData);

    // Fetch live stock in parallel
    var stockPromises = parts.map(function(p) { return fetchStock(p.partNumber); });
    var stockResults = await Promise.all(stockPromises);
    var stockDataMap = {};
    parts.forEach(function(p, i) { stockDataMap[p.partNumber] = stockResults[i]; });

    // Sort by in-stock first
    parts = parts.slice().sort(function(a, b) {
      var aS = stockDataMap[a.partNumber] ? stockDataMap[a.partNumber].totalStock : 0;
      var bS = stockDataMap[b.partNumber] ? stockDataMap[b.partNumber].totalStock : 0;
      return (bS > 0 ? 1 : 0) - (aS > 0 ? 1 : 0) || bS - aS;
    });

    return res.json({
      text: "Found **" + parts.length + " validated parts** with live stock from Digi-Key and Mouser:",
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
  console.log("  POST /api/chat    - Claude suggestions + DigiKey validation");
  console.log("  POST /api/track   - interaction tracking");
  console.log("  POST /api/feedback - part feedback\n");
});
