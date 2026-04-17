const express = require("express");
const cors = require("cors");
require("dotenv").config();

console.log("=== PartTensor Backend Starting ===");
console.log("Anthropic:", process.env.ANTHROPIC_API_KEY ? "OK" : "MISSING");
console.log("Nexar:", process.env.NEXAR_CLIENT_ID ? "OK" : "MISSING");
console.log("Mouser:", process.env.MOUSER_API_KEY ? "OK" : "MISSING");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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
// NEXAR TOKEN
// =============================================
var nexarToken = null;
var nexarTokenExpiry = null;

async function getNexarToken() {
if (nexarToken && nexarTokenExpiry && Date.now() < nexarTokenExpiry) return nexarToken;
var fetch = (await import("node-fetch")).default;
try {
var res = await fetch("https://identity.nexar.com/connect/token", {
method: "POST",
headers: { "Content-Type": "application/x-www-form-urlencoded" },
body: new URLSearchParams({
grant_type: "client_credentials",
client_id: process.env.NEXAR_CLIENT_ID,
client_secret: process.env.NEXAR_CLIENT_SECRET,
}),
});
var data = await res.json();
if (data.access_token) {
nexarToken = data.access_token;
nexarTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
console.log("Nexar token refreshed");
return nexarToken;
}
console.error("Nexar token error:", JSON.stringify(data).substring(0, 200));
return null;
} catch (e) {
console.error("Nexar token failed:", e.message);
return null;
}
}

// =============================================
// NEXAR GRAPHQL SEARCH
// Real parametric search with exact spec filtering
// =============================================
async function searchNexar(componentType, requiredSpecs) {
try {
var fetch = (await import("node-fetch")).default;
var token = await getNexarToken();
if (!token) { console.error("No Nexar token"); return null; }

```
// Build spec filters based on component type
var filters = buildNexarFilters(componentType, requiredSpecs);
console.log("Nexar search:", componentType, "filters:", JSON.stringify(filters));

var query = [
  "query SearchParts($filters: PartFilterInput!, $limit: Int!) {",
  "  supSearchMpn(q: \"\", filters: $filters, limit: $limit, currency: \"USD\", country: \"US\") {",
  "    hits",
  "    results {",
  "      part {",
  "        mpn",
  "        manufacturer { name }",
  "        shortDescription",
  "        specs { attribute { name shortname } displayValue }",
  "        bestDatasheet { url }",
  "        sellers(includeBrokers: false) {",
  "          company { name }",
  "          offers {",
  "            inventoryLevel",
  "            prices { quantity price currency }",
  "            clickUrl",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

var variables = {
  filters: filters,
  limit: 10,
};

var res = await fetch("https://api.nexar.com/graphql", {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: query, variables: variables }),
});

if (!res.ok) {
  var errText = await res.text();
  console.error("Nexar search failed:", res.status, errText.substring(0, 300));
  return null;
}

var data = await res.json();
if (data.errors) {
  console.error("Nexar GraphQL errors:", JSON.stringify(data.errors).substring(0, 300));
  return null;
}

var results = (data.data && data.data.supSearchMpn && data.data.supSearchMpn.results) || [];
console.log("Nexar returned", results.length, "results");
return results;
```

} catch (e) {
console.error("Nexar search error:", e.message);
return null;
}
}

// =============================================
// BUILD NEXAR FILTERS
// Maps component type + required specs to Nexar filter format
// =============================================
function buildNexarFilters(componentType, specs) {
var filters = {};

// Category mapping
var categoryMap = {
mosfet_n:         "MOSFETs",
mosfet_p:         "MOSFETs",
igbt:             "IGBTs",
bjt_npn:          "Transistors",
bjt_pnp:          "Transistors",
diode_rectifier:  "Diodes",
diode_schottky:   "Schottky Diodes",
diode_zener:      "Zener Diodes",
opamp:            "Op Amps",
comparator:       "Comparators",
ldo:              "LDO Regulators",
dcdc_buck:        "DC-DC Converters",
gate_driver:      "Gate Drivers",
voltage_ref:      "Voltage References",
cap_ceramic:      "Ceramic Capacitors",
cap_electrolytic: "Electrolytic Capacitors",
cap_tantalum:     "Tantalum Capacitors",
cap_film:         "Film Capacitors",
inductor:         "Inductors",
resistor_smd:     "Chip Resistors",
current_sensor:   "Current Sensors",
temp_sensor:      "Temperature Sensors",
};

if (categoryMap[componentType]) {
filters.categories = [categoryMap[componentType]];
}

// Add subcategory for N vs P channel MOSFET
if (componentType === "mosfet_n") filters.q = "N-Channel";
if (componentType === "mosfet_p") filters.q = "P-Channel";
if (componentType === "bjt_npn") filters.q = "NPN";
if (componentType === "bjt_pnp") filters.q = "PNP";

// Spec filters using Nexar attribute shortnames
var specs_filter = [];

if (componentType === "mosfet_n" || componentType === "mosfet_p" || componentType === "igbt") {
if (specs.voltage) specs_filter.push({ shortname: "vds", min: String(specs.voltage) });
if (specs.current) specs_filter.push({ shortname: "id", min: String(specs.current) });
} else if (componentType === "bjt_npn" || componentType === "bjt_pnp") {
if (specs.voltage) specs_filter.push({ shortname: "vceo", min: String(specs.voltage) });
if (specs.current) specs_filter.push({ shortname: "ic", min: String(specs.current) });
} else if (componentType === "diode_rectifier" || componentType === "diode_schottky") {
if (specs.voltage) specs_filter.push({ shortname: "vr", min: String(specs.voltage) });
if (specs.current) specs_filter.push({ shortname: "if", min: String(specs.current) });
} else if (componentType === "opamp") {
if (specs.gbwMHz) specs_filter.push({ shortname: "gbp", min: String(specs.gbwMHz) });
} else if (componentType === "ldo") {
if (specs.current) specs_filter.push({ shortname: "iout", min: String(specs.current) });
if (specs.outputV) specs_filter.push({ shortname: "vout", min: String(specs.outputV * 0.95), max: String(specs.outputV * 1.05) });
} else if (componentType === "cap_ceramic" || componentType === "cap_electrolytic" || componentType === "cap_tantalum" || componentType === "cap_film") {
if (specs.voltage) specs_filter.push({ shortname: "vrated", min: String(specs.voltage) });
if (specs.capacitanceUF) specs_filter.push({ shortname: "capacitance", min: String(specs.capacitanceUF * 0.7), max: String(specs.capacitanceUF * 1.3) });
} else if (componentType === "inductor") {
if (specs.current) specs_filter.push({ shortname: "irated", min: String(specs.current) });
if (specs.inductanceUH) specs_filter.push({ shortname: "inductance", min: String(specs.inductanceUH * 0.75), max: String(specs.inductanceUH * 1.25) });
}

if (specs_filter.length > 0) filters.specs = specs_filter;

return filters;
}

// =============================================
// CONVERT NEXAR RESULT TO OUR PART FORMAT
// =============================================
function convertNexarResult(result, componentType) {
var part = result.part || {};
var mpn = part.mpn || "";
var manufacturer = (part.manufacturer && part.manufacturer.name) || "";
var description = part.shortDescription || "";
var specsArr = part.specs || [];
var sellers = part.sellers || [];

// Extract specs from Nexar spec array
var specMap = {};
for (var i = 0; i < specsArr.length; i++) {
var attr = specsArr[i].attribute || {};
var shortname = (attr.shortname || "").toLowerCase();
var name = (attr.name || "").toLowerCase();
var val = specsArr[i].displayValue || "";
specMap[shortname] = val;
specMap[name] = val;
}

// Build key specs based on component type
var keySpecs = [];
var pkg = specMap["case_package"] || specMap["package"] || specMap["case"] || "";

if (componentType === "mosfet_n" || componentType === "mosfet_p" || componentType === "igbt") {
if (specMap["vds"]) keySpecs.push({ label: "VDS", value: specMap["vds"].replace(/[^0-9.]/g, ""), unit: "V" });
if (specMap["id"]) keySpecs.push({ label: "ID", value: specMap["id"].replace(/[^0-9.]/g, ""), unit: "A" });
if (specMap["rds_on"] || specMap["rdson"]) keySpecs.push({ label: "RDS(on)", value: (specMap["rds_on"] || specMap["rdson"]).replace(/[^0-9.]/g, ""), unit: "mOhm" });
if (specMap["pd"]) keySpecs.push({ label: "Pd", value: specMap["pd"].replace(/[^0-9.]/g, ""), unit: "W" });
if (pkg) keySpecs.push({ label: "Package", value: pkg, unit: "" });
} else if (componentType === "bjt_npn" || componentType === "bjt_pnp") {
if (specMap["vceo"]) keySpecs.push({ label: "Vce", value: specMap["vceo"].replace(/[^0-9.]/g, ""), unit: "V" });
if (specMap["ic"]) keySpecs.push({ label: "Ic", value: specMap["ic"].replace(/[^0-9.]/g, ""), unit: "A" });
if (specMap["pd"]) keySpecs.push({ label: "Pd", value: specMap["pd"].replace(/[^0-9.]/g, ""), unit: "W" });
if (pkg) keySpecs.push({ label: "Package", value: pkg, unit: "" });
} else if (componentType === "diode_rectifier" || componentType === "diode_schottky") {
if (specMap["vr"]) keySpecs.push({ label: "Vrrm", value: specMap["vr"].replace(/[^0-9.]/g, ""), unit: "V" });
if (specMap["if"]) keySpecs.push({ label: "Io", value: specMap["if"].replace(/[^0-9.]/g, ""), unit: "A" });
if (specMap["vf"]) keySpecs.push({ label: "Vf", value: specMap["vf"].replace(/[^0-9.]/g, ""), unit: "V" });
if (pkg) keySpecs.push({ label: "Package", value: pkg, unit: "" });
} else if (componentType === "opamp") {
if (specMap["gbp"] || specMap["gbw"]) keySpecs.push({ label: "GBW", value: (specMap["gbp"] || specMap["gbw"]).replace(/[^0-9.]/g, ""), unit: "MHz" });
if (specMap["vs_max"]) keySpecs.push({ label: "Vcc Max", value: specMap["vs_max"].replace(/[^0-9.]/g, ""), unit: "V" });
if (pkg) keySpecs.push({ label: "Package", value: pkg, unit: "" });
} else if (componentType === "ldo") {
if (specMap["vout"]) keySpecs.push({ label: "Vout", value: specMap["vout"].replace(/[^0-9.]/g, ""), unit: "V" });
if (specMap["iout"]) keySpecs.push({ label: "Iout", value: specMap["iout"].replace(/[^0-9.]/g, ""), unit: "A" });
if (specMap["vin_max"]) keySpecs.push({ label: "Vin Max", value: specMap["vin_max"].replace(/[^0-9.]/g, ""), unit: "V" });
if (specMap["vdo"]) keySpecs.push({ label: "Dropout", value: specMap["vdo"].replace(/[^0-9.]/g, ""), unit: "mV" });
if (pkg) keySpecs.push({ label: "Package", value: pkg, unit: "" });
} else if (componentType && componentType.startsWith("cap")) {
if (specMap["capacitance"]) keySpecs.push({ label: "Cap", value: specMap["capacitance"].replace(/[^0-9.]/g, ""), unit: "uF" });
if (specMap["vrated"]) keySpecs.push({ label: "Voltage", value: specMap["vrated"].replace(/[^0-9.]/g, ""), unit: "V" });
if (pkg) keySpecs.push({ label: "Package", value: pkg, unit: "" });
} else if (componentType === "inductor") {
if (specMap["inductance"]) keySpecs.push({ label: "L", value: specMap["inductance"].replace(/[^0-9.]/g, ""), unit: "uH" });
if (specMap["irated"]) keySpecs.push({ label: "Irated", value: specMap["irated"].replace(/[^0-9.]/g, ""), unit: "A" });
if (specMap["dcr"]) keySpecs.push({ label: "DCR", value: specMap["dcr"].replace(/[^0-9.]/g, ""), unit: "mOhm" });
if (pkg) keySpecs.push({ label: "Package", value: pkg, unit: "" });
} else {
// Generic - take first 4 specs
var count = 0;
for (var si = 0; si < specsArr.length && count < 4; si++) {
var sv = specsArr[si].displayValue || "";
if (sv && sv !== "None") { keySpecs.push({ label: (specsArr[si].attribute && specsArr[si].attribute.name) || "", value: sv.replace(/[^0-9.]/g, ""), unit: "" }); count++; }
}
if (pkg) keySpecs.push({ label: "Package", value: pkg, unit: "" });
}

// Extract stock and price from sellers
var dkStock = 0, dkPrice = null, dkUrl = "";
var mouserStock = 0, mouserPrice = null, mouserUrl = "";
var totalStock = 0;

for (var si2 = 0; si2 < sellers.length; si2++) {
var seller = sellers[si2];
var sellerName = (seller.company && seller.company.name) || "";
var offers = seller.offers || [];
for (var oi = 0; oi < offers.length; oi++) {
var offer = offers[oi];
var inv = offer.inventoryLevel || 0;
var price = offer.prices && offer.prices[0] && offer.prices[0].price;
var url = offer.clickUrl || "";
totalStock += inv;
if (sellerName.toLowerCase().includes("digi-key") || sellerName.toLowerCase().includes("digikey")) {
dkStock += inv; if (!dkPrice && price) dkPrice = "$" + parseFloat(price).toFixed(3); dkUrl = url;
} else if (sellerName.toLowerCase().includes("mouser")) {
mouserStock += inv; if (!mouserPrice && price) mouserPrice = "$" + parseFloat(price).toFixed(3); mouserUrl = url;
}
}
}

var bestPrice = dkPrice || mouserPrice;
var bestPriceSource = dkPrice ? "Digi-Key" : mouserPrice ? "Mouser" : null;

return {
partNumber: mpn,
manufacturer: manufacturer,
type: (componentType && componentType.replace(/_/g, " ").toUpperCase()) || description.split(" ").slice(0, 3).join(" "),
description: description,
package: pkg,
keySpecs: keySpecs,
dkStock: dkStock,
dkPrice: dkPrice,
dkUrl: dkUrl,
rank: "alternative",
aeComment: "",
caution: null,
applications: [],
stockData: {
found: totalStock > 0,
totalStock: totalStock,
bestPrice: bestPrice,
bestPriceSource: bestPriceSource,
digikey: dkStock > 0 ? { found: true, stock: dkStock, price: dkPrice, url: dkUrl } : null,
mouser: mouserStock > 0 ? { found: true, stock: mouserStock, price: mouserPrice, url: mouserUrl } : null,
octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(mpn),
},
};
}

// =============================================
// NEXAR SINGLE PART LOOKUP (for alternatives)
// =============================================
async function lookupNexarPart(mpn) {
try {
var fetch = (await import("node-fetch")).default;
var token = await getNexarToken();
if (!token) return null;

```
var query = [
  "query LookupPart($mpn: String!) {",
  "  supSearchMpn(q: $mpn, limit: 3, currency: \"USD\", country: \"US\") {",
  "    results {",
  "      part {",
  "        mpn",
  "        manufacturer { name }",
  "        shortDescription",
  "        category { name }",
  "        specs { attribute { name shortname } displayValue }",
  "        sellers(includeBrokers: false) {",
  "          company { name }",
  "          offers { inventoryLevel prices { quantity price currency } clickUrl }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

var res = await fetch("https://api.nexar.com/graphql", {
  method: "POST",
  headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
  body: JSON.stringify({ query: query, variables: { mpn: mpn } }),
});

if (!res.ok) return null;
var data = await res.json();
var results = (data.data && data.data.supSearchMpn && data.data.supSearchMpn.results) || [];
if (results.length === 0) return null;
return results[0].part;
```

} catch (e) { console.error("Nexar lookup failed for " + mpn + ":", e.message); return null; }
}

// =============================================
// DETECT COMPONENT TYPE
// =============================================
function detectComponentType(query) {
var q = query.toLowerCase();
q = q.replace(/for\s+(motor|pfc|inverter|converter|charger|driver|controller|amplifier|supply|circuit|switching|drive|load|battery|solar|power)[^,]*/g, "");
q = q.replace(/in\s+(motor|pfc|inverter|converter|charger|driver|controller)[^,]*/g, "");
if (q.includes("igbt")) return "igbt";
if (q.includes("mosfet") || q.includes(" fet") || q.includes("nmos") || q.includes("pmos")) {
if (q.includes("p-channel") || q.includes("p channel") || q.includes("pmos")) return "mosfet_p";
return "mosfet_n";
}
if (q.includes("pnp")) return "bjt_pnp";
if (q.includes("npn") || (q.includes("bjt") && !q.includes("pnp")) || (q.includes("transistor") && !q.includes("mosfet"))) return "bjt_npn";
if (q.includes("schottky")) return "diode_schottky";
if (q.includes("zener")) return "diode_zener";
if (q.includes("diode") || q.includes("rectifier")) return "diode_rectifier";
if (q.includes("gate driver") || q.includes("gate drive ic")) return "gate_driver";
if (q.includes("op-amp") || q.includes("opamp") || q.includes("op amp") || q.includes("operational amplifier")) return "opamp";
if (q.includes("comparator")) return "comparator";
if (q.includes("voltage reference") || q.includes("vref")) return "voltage_ref";
if (q.includes("ldo") || (q.includes("linear regulator") && !q.includes("switching"))) return "ldo";
if (q.includes("dc-dc") || q.includes("buck") || q.includes("boost") || q.includes("switching regulator")) return "dcdc_buck";
if (q.includes("electrolytic") || q.includes("aluminum capacitor")) return "cap_electrolytic";
if (q.includes("tantalum")) return "cap_tantalum";
if (q.includes("film capacitor")) return "cap_film";
if (q.includes("ceramic") || q.includes("mlcc")) return "cap_ceramic";
if (q.includes("capacitor") || q.match(/\d+\s*(uf|nf|pf)\b/)) return "cap_ceramic";
if (q.includes("inductor") || q.includes("choke") || q.match(/\d+\s*(uh|nh|mh)\b/)) return "inductor";
if (q.includes("resistor") || q.match(/\d+\s*(ohm|kohm)\b/)) return "resistor_smd";
if (q.includes("current sensor") || q.includes("current sense")) return "current_sensor";
if (q.includes("temperature sensor") || q.includes("temp sensor")) return "temp_sensor";
return null;
}

// =============================================
// EXTRACT REQUIRED SPECS FROM QUERY
// =============================================
function extractRequiredSpecs(query) {
var lower = query.toLowerCase();
var specs = {};
var vMatches = lower.match(/(\d+(?:.\d+)?)\s*v\b/gi) || [];
if (vMatches.length > 0) { var volts = vMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; }); if (volts.length > 0) specs.voltage = Math.max.apply(null, volts); }
var aMatches = lower.match(/(\d+(?:.\d+)?)\s*a\b/gi) || [];
if (aMatches.length > 0) { var amps = aMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; }); if (amps.length > 0) specs.current = Math.max.apply(null, amps); }
var maMatches = lower.match(/(\d+(?:.\d+)?)\s*ma\b/gi) || [];
if (maMatches.length > 0 && !specs.current) { var mamps = maMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v); }); if (mamps.length > 0) specs.currentMA = Math.max.apply(null, mamps); }
var ufM = lower.match(/(\d+(?:.\d+)?)\s*uf\b/gi) || [];
if (ufM.length > 0) specs.capacitanceUF = parseFloat(ufM[0]);
var nfM = lower.match(/(\d+(?:.\d+)?)\s*nf\b/gi) || [];
if (nfM.length > 0 && !specs.capacitanceUF) specs.capacitanceNF = parseFloat(nfM[0]);
var uhM = lower.match(/(\d+(?:.\d+)?)\s*uh\b/gi) || [];
if (uhM.length > 0) specs.inductanceUH = parseFloat(uhM[0]);
var mhzM = lower.match(/(\d+(?:.\d+)?)\s*mhz\b/gi) || [];
if (mhzM.length > 0 && (lower.includes("gbw") || lower.includes("bandwidth"))) specs.gbwMHz = parseFloat(mhzM[0]);
var mvM = lower.match(/(\d+(?:.\d+)?)\s*mv\b/gi) || [];
if (mvM.length > 0 && (lower.includes("dropout") || lower.includes("ldo"))) specs.dropoutMV = parseFloat(mvM[0]);
console.log("Required specs:", JSON.stringify(specs));
return specs;
}

// =============================================
// EXTRACT JSON
// =============================================
function extractJSON(text) {
var clean = text.replace(/`json/gi, "").replace(/`/g, "").trim();
var depth = 0, start = -1, end = -1;
for (var i = 0; i < clean.length; i++) {
if (clean[i] === "{") { if (depth === 0) start = i; depth++; }
else if (clean[i] === "}") { depth–; if (depth === 0) { end = i; break; } }
}
if (start === -1 || end === -1) return null;
try { return JSON.parse(clean.substring(start, end + 1)); } catch (e) { return null; }
}

function extractPartNumber(text) {
var m1 = text.match(/\b([A-Z]{1,6}[0-9]{2,}[A-Z0-9-]*)\b/gi) || [];
var m2 = text.match(/\b([0-9]+[-][0-9A-Z][-0-9A-Z]*)\b/gi) || [];
var all = m1.concat(m2).filter(function(m) { return m.length >= 4; });
if (all.length === 0) return null;
return all.sort(function(a, b) { return b.length - a.length; })[0];
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
var INTENT_SYSTEM = "You classify hardware engineering queries. Consider full conversation context. If the new message is a follow-up refinement (like ‘only in stock’, ‘cheaper’, ‘different package’, ‘find alternatives’), classify it as the SAME intent as the previous turn. Any message asking for a component, part, chip, MOSFET, op-amp, capacitor, inductor, resistor, diode, regulator, sensor, or any electronic part MUST be classified as part_search. Respond ONLY with JSON: {"intent":"part_search|find_alternatives|generate_bom|circuit_question|calculation|correction|general","partNumber":"extracted part number or null","needsMoreInfo":false,"followUpQuestion":null}";

var ENGINEERING_SYSTEM = "You are PartTensor, a senior hardware application engineer AI. Help engineers with circuit design, calculations, and troubleshooting. Be direct, technical and precise. Use real formulas and examples. Format with **bold headers** and - bullet points.";

var ENRICHMENT_SYSTEM = "You are a senior application engineer. You are given real parts with real specs from Nexar/Octopart. Your job is to rank them and add engineering context. DO NOT change part numbers or specs. Respond ONLY with raw JSON starting with {: {"category":"N-Channel MOSFET","interpretation":"one sentence","designTip":"tip","rankedResults":[{"partNumber":"IRF540NPBF","rank":"top","aeComment":"reason","caution":null,"applications":["Motor Drive"]}]}";

var BOM_SYSTEM = "You are a senior hardware application engineer. Generate a smart Bill of Materials. Only critical components: MOSFETs, ICs, drivers, specialized inductors, electrolytic caps, current sense resistors, crystals, connectors, optocouplers, diodes, sensors. NO generic resistors, 100nF caps, generic LEDs. Use full part numbers. 5 keySpecs per part. Respond ONLY with raw JSON starting with {: {"bomItems":[{"id":1,"function":"Gate Driver","partNumber":"IR2184SPBF","manufacturer":"Infineon","description":"one line","category":"IC","quantity":1,"keySpecs":"600V 2A SO-8","package":"SO-8","priority":"critical","unitPrice":"$1.20","notes":null}],"projectName":"name","description":"sentence","voltage":"V","power":"W","designNotes":"notes","totalEstimate":"$15-25"}";

var PASSIVE_KEYWORDS = ["connector","receptacle","plug","socket","jack","header","terminal","coax","mmcx","sma","bnc","crystal","resonator","transformer","relay","switch","fuse","varistor","thermistor","potentiometer","antenna","balun"];
function isPassiveConnector(description, categoryName) {
var text = ((description || "") + " " + (categoryName || "")).toLowerCase();
for (var i = 0; i < PASSIVE_KEYWORDS.length; i++) { if (text.indexOf(PASSIVE_KEYWORDS[i]) !== -1) return true; }
return false;
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

```
var requiredSpecs = extractRequiredSpecs(message);
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

  console.log("Looking up part:", pn);
  var originalPart = await lookupNexarPart(pn);
  if (!originalPart) return res.json({ text: "Could not find " + pn + " on Nexar. Please check the part number.", intent: intent, mode: "question" });

  var description = originalPart.shortDescription || "";
  var categoryName = (originalPart.category && originalPart.category.name) || "";
  if (isPassiveConnector(description, categoryName)) {
    return res.json({ text: "For " + pn + " (" + categoryName + "), use parametric search for the most accurate alternatives.", mode: "passive_connector_alt", originalPart: pn, originalDescription: description, categoryName: categoryName, searchLinks: [{ name: "Octopart Search", url: "https://octopart.com/search?q=" + encodeURIComponent(pn), description: "Find alternatives on Octopart" }, { name: "Digi-Key Search", url: "https://www.digikey.com/en/products/filter/" + encodeURIComponent(pn), description: "Search Digi-Key" }], intent: intent });
  }

  // Extract specs from original part
  var origSpecs = {};
  var specsArr = originalPart.specs || [];
  for (var si = 0; si < specsArr.length; si++) {
    var sn = ((specsArr[si].attribute && specsArr[si].attribute.shortname) || "").toLowerCase();
    var sv = specsArr[si].displayValue || "";
    var snum = parseFloat(sv.replace(/[^0-9.]/g, ""));
    if (sn === "vds" && !isNaN(snum)) origSpecs.voltage = snum;
    if (sn === "id" && !isNaN(snum)) origSpecs.current = snum;
    if (sn === "vceo" && !isNaN(snum) && !origSpecs.voltage) origSpecs.voltage = snum;
    if (sn === "ic" && !isNaN(snum) && !origSpecs.current) origSpecs.current = snum;
    if (sn === "vr" && !isNaN(snum) && !origSpecs.voltage) origSpecs.voltage = snum;
    if ((sn === "capacitance" || sn === "cap") && !isNaN(snum)) origSpecs.capacitanceUF = snum;
    if (sn === "inductance" && !isNaN(snum)) origSpecs.inductanceUH = snum;
  }

  var altCompType = detectComponentType(description + " " + categoryName);
  var altResults = altCompType ? await searchNexar(altCompType, origSpecs) : null;

  if (altResults && altResults.length > 0) {
    var altParts = altResults.map(function(r) { return convertNexarResult(r, altCompType); })
      .filter(function(p) { return p.partNumber.toUpperCase() !== pn.toUpperCase() && p.stockData.totalStock > 0; })
      .slice(0, 4);

    var altStockMap = {};
    altParts.forEach(function(p) { altStockMap[p.partNumber] = p.stockData; p.compatibility = "functional"; p.whyAlternative = "Real Nexar result matching " + pn + " specs"; });

    var altEnrichPrompt = "User wants alternatives to " + pn + " (" + description + ").\n\nParts from Nexar with real specs:\n" + altParts.map(function(p, i) { return (i + 1) + ". " + p.partNumber + " (" + p.manufacturer + ") Stock: " + p.stockData.totalStock + " Specs: " + p.keySpecs.map(function(s) { return s.label + "=" + s.value + s.unit; }).join(", "); }).join("\n");
    var altEnrich = await callAI(ENRICHMENT_SYSTEM, [{ role: "user", content: altEnrichPrompt }], 1500);
    if (altEnrich.text) {
      var altEnrichData = extractJSON(altEnrich.text);
      if (altEnrichData && altEnrichData.rankedResults) {
        altEnrichData.rankedResults.forEach(function(r) { altParts.forEach(function(p) { if (p.partNumber === r.partNumber) { p.rank = r.rank || "alternative"; p.aeComment = r.aeComment || ""; p.caution = r.caution || null; p.applications = r.applications || []; } }); });
      }
    }
    return res.json({ text: "Here are " + altParts.length + " alternatives for " + pn + " sourced from Nexar:", mode: "alt", originalPart: pn, alternatives: altParts, stockData: altStockMap, intent: intent });
  }

  return res.json({ text: "Could not find alternatives for " + pn + ". Please try again.", intent: intent, mode: "text" });
}

// GENERATE BOM
if (intent === "generate_bom") {
  var bomCacheKey = "bom:" + message.toLowerCase().trim();
  var cachedBOM = getCached(aiCache, bomCacheKey);
  if (cachedBOM) { console.log("BOM cache hit"); return res.json(cachedBOM); }
  var bomResult = await callAI(BOM_SYSTEM, fullMessages, 4000);
  var bomData = bomResult.text ? extractJSON(bomResult.text) : null;
  if (!bomData || !bomData.bomItems) return res.json({ text: "Could you describe the application in more detail?", intent: intent, mode: "question" });
  // Lookup stock for each BOM part via Nexar
  var bomStockMap = {};
  for (var bi = 0; bi < bomData.bomItems.length; bi++) {
    var bp = bomData.bomItems[bi].partNumber;
    if (!bp) continue;
    var cached = getCached(stockCache, bp);
    if (cached) { bomStockMap[bp] = cached; continue; }
    var bPart = await lookupNexarPart(bp);
    if (bPart) {
      var bResult = convertNexarResult({ part: bPart }, null);
      bomStockMap[bp] = bResult.stockData;
      setCache(stockCache, bp, bResult.stockData, STOCK_TTL);
    }
  }
  bomData.stockData = bomStockMap;
  var bomText = "Here is a sourcing-ready BOM for your " + bomData.projectName + " with " + bomData.bomItems.length + " critical components:";
  var bomResponse = Object.assign({ text: bomText, intent: intent }, bomData);
  setCache(aiCache, bomCacheKey, bomResponse, AI_TTL);
  return res.json(bomResponse);
}

// PART SEARCH - Nexar parametric search
var componentType = detectComponentType(message);
console.log("Component type:", componentType);

if (!componentType) {
  var unkResult = await callAI(ENGINEERING_SYSTEM, fullMessages, 1500);
  return res.json({ text: unkResult.text || "I could not identify the component type. Please specify: MOSFET, op-amp, capacitor, inductor, LDO, diode, etc.", intent: intent, mode: "text" });
}

var nexarResults = await searchNexar(componentType, requiredSpecs);

if (!nexarResults || nexarResults.length === 0) {
  return res.json({ text: "No results found for " + componentType.replace(/_/g, " ") + " with those specs. Try relaxing the requirements.", intent: intent, mode: "text" });
}

// Convert and filter - only in-stock parts
var parts = nexarResults.map(function(r) { return convertNexarResult(r, componentType); })
  .filter(function(p) { return p.stockData.totalStock > 0; })
  .slice(0, 4);

if (parts.length === 0) {
  return res.json({ text: "Found parts but none are currently in stock. Try searching without stock filter.", intent: intent, mode: "text" });
}

// Build stock data map
var stockDataMap = {};
parts.forEach(function(p) { stockDataMap[p.partNumber] = p.stockData; });

// AI enrichment
var enrichPrompt = "User asked: " + message + "\n\nRequired: voltage>=" + (requiredSpecs.voltage || "any") + "V current>=" + (requiredSpecs.current || "any") + "A\n\nReal parts from Nexar with verified specs:\n" + parts.map(function(p, idx) { return (idx + 1) + ". " + p.partNumber + " (" + p.manufacturer + ") Stock: " + p.stockData.totalStock + " Specs: " + p.keySpecs.map(function(s) { return s.label + "=" + s.value + s.unit; }).join(", "); }).join("\n");
var enrichResult = await callAI(ENRICHMENT_SYSTEM, [{ role: "user", content: enrichPrompt }], 1500);
var category = componentType.replace(/_/g, " ");
var interpretation = "Real-time Nexar results";
var designTip = "";

if (enrichResult.text) {
  var enrichData = extractJSON(enrichResult.text);
  if (enrichData) {
    if (enrichData.category) category = enrichData.category;
    if (enrichData.interpretation) interpretation = enrichData.interpretation;
    if (enrichData.designTip) designTip = enrichData.designTip;
    if (enrichData.rankedResults) {
      enrichData.rankedResults.forEach(function(r) { parts.forEach(function(p) { if (p.partNumber === r.partNumber) { p.rank = r.rank || "alternative"; p.aeComment = r.aeComment || ""; p.caution = r.caution || null; p.applications = r.applications || []; } }); });
    }
  }
}

return res.json({ text: "Found " + parts.length + " real parts from Nexar catalog -- " + interpretation + ". Best match first:", mode: "search", category: category, interpretation: interpretation, results: parts, stockData: stockDataMap, designTip: designTip, intent: intent, source: "Nexar" });
```

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
if (partNumbers.length === 0) return res.status(400).json({ error: "No part numbers found." });
var results = [];
var limit = Math.min(partNumbers.length, 15);
for (var pi = 0; pi < limit; pi++) {
var pn = partNumbers[pi];
if (!pn) continue;
var row = { partNumber: pn, description: "", category: "", keySpecs: "", stock: 0, bestPrice: "", dkStock: 0, mousStock: 0, alt1: "", alt2: "", alt3: "" };
try {
var partData = await lookupNexarPart(pn);
if (partData) {
var converted = convertNexarResult({ part: partData }, detectComponentType((partData.shortDescription || "") + " " + ((partData.category && partData.category.name) || "")));
row.description = partData.shortDescription || "";
row.category = (partData.category && partData.category.name) || "";
row.keySpecs = converted.keySpecs.map(function(s) { return s.label + "=" + s.value + s.unit; }).join("; ");
row.stock = converted.stockData.totalStock;
row.bestPrice = converted.stockData.bestPrice || "";
row.dkStock = converted.stockData.digikey ? converted.stockData.digikey.stock : 0;
row.mousStock = converted.stockData.mouser ? converted.stockData.mouser.stock : 0;

```
      // Find alternatives
      var ct = detectComponentType((partData.shortDescription || "") + " " + ((partData.category && partData.category.name) || ""));
      if (ct && !isPassiveConnector(row.description, row.category)) {
        var origSpecs2 = {};
        var specsArr2 = partData.specs || [];
        for (var si3 = 0; si3 < specsArr2.length; si3++) {
          var sn2 = ((specsArr2[si3].attribute && specsArr2[si3].attribute.shortname) || "").toLowerCase();
          var sv2 = specsArr2[si3].displayValue || "";
          var snum2 = parseFloat(sv2.replace(/[^0-9.]/g, ""));
          if (sn2 === "vds" && !isNaN(snum2)) origSpecs2.voltage = snum2;
          if (sn2 === "id" && !isNaN(snum2)) origSpecs2.current = snum2;
        }
        var altRes2 = await searchNexar(ct, origSpecs2);
        if (altRes2 && altRes2.length > 0) {
          var altParts2 = altRes2.map(function(r) { return convertNexarResult(r, ct); }).filter(function(p) { return p.partNumber.toUpperCase() !== pn.toUpperCase() && p.stockData.totalStock > 0; }).slice(0, 3);
          if (altParts2[0]) row.alt1 = altParts2[0].partNumber + " (" + altParts2[0].manufacturer + ")";
          if (altParts2[1]) row.alt2 = altParts2[1].partNumber + " (" + altParts2[1].manufacturer + ")";
          if (altParts2[2]) row.alt3 = altParts2[2].partNumber + " (" + altParts2[2].manufacturer + ")";
        }
      }
    }
  } catch (e) { console.error("Excel lookup failed for " + pn, e.message); }
  results.push(row);
}
var csvHeaders = ["Part Number","Description","Category","Key Specs","Total Stock","Best Price","Digi-Key Stock","Mouser Stock","Alternative 1","Alternative 2","Alternative 3"];
var csvRows = results.map(function(r) { return [r.partNumber, r.description, r.category, r.keySpecs, r.stock, r.bestPrice, r.dkStock, r.mousStock, r.alt1, r.alt2, r.alt3]; });
var csv = [csvHeaders].concat(csvRows).map(function(row) { return row.map(function(c) { return '"' + String(c || "").replace(/"/g, '""') + '"'; }).join(","); }).join("\n");
res.setHeader("Content-Type", "text/csv");
res.setHeader("Content-Disposition", "attachment; filename=BOM_PartTensor.csv");
res.send(csv);
```

} catch (err) { console.error("Excel BOM error:", err.message); res.status(500).json({ error: "Failed to process file: " + err.message }); }
});

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
console.log("\nPartTensor backend running on port " + PORT);
console.log("  GET  /api/health");
console.log("  POST /api/chat  - Nexar parametric search");
console.log("  POST /api/excel-bom\n");
});