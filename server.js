const express = require(“express”);
const cors = require(“cors”);
require(“dotenv”).config();

console.log(”=== PartTensor Backend Starting ===”);
console.log(“Anthropic:”, process.env.ANTHROPIC_API_KEY ? “OK” : “MISSING”);
console.log(“DigiKey:”, process.env.DIGIKEY_CLIENT_ID ? “OK” : “MISSING”);
console.log(“Mouser:”, process.env.MOUSER_API_KEY ? “OK” : “MISSING”);

const app = express();
app.use(cors());
app.use(express.json({ limit: “10mb” }));

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
var fetch = (await import(“node-fetch”)).default;
try {
var res = await fetch(“https://api.digikey.com/v1/oauth2/token”, {
method: “POST”,
headers: { “Content-Type”: “application/x-www-form-urlencoded” },
body: new URLSearchParams({
grant_type: “client_credentials”,
client_id: process.env.DIGIKEY_CLIENT_ID,
client_secret: process.env.DIGIKEY_CLIENT_SECRET,
}),
});
var data = await res.json();
if (data.access_token) {
digikeyToken = data.access_token;
digikeyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
console.log(“DigiKey token refreshed”);
return digikeyToken;
}
console.error(“DigiKey token error:”, JSON.stringify(data).substring(0, 200));
return null;
} catch (e) {
console.error(“DigiKey token failed:”, e.message);
return null;
}
}

// =============================================
// DIGIKEY CATEGORY IDs
// Real DigiKey category IDs - never mix keywords with these
// =============================================
var DK_CATEGORIES = {
“mosfet_n”:              { id: 278,  name: “N-Channel MOSFET”,            paramLabel: “MOSFET N-Channel” },
“mosfet_p”:              { id: 277,  name: “P-Channel MOSFET”,            paramLabel: “MOSFET P-Channel” },
“igbt”:                  { id: 280,  name: “IGBT”,                        paramLabel: “IGBT” },
“bjt_npn”:               { id: 281,  name: “NPN Transistor”,              paramLabel: “BJT NPN” },
“bjt_pnp”:               { id: 282,  name: “PNP Transistor”,              paramLabel: “BJT PNP” },
“diode_rectifier”:       { id: 286,  name: “Rectifier Diode”,             paramLabel: “Rectifier Diode” },
“diode_schottky”:        { id: 287,  name: “Schottky Diode”,              paramLabel: “Schottky Diode” },
“diode_zener”:           { id: 291,  name: “Zener Diode”,                 paramLabel: “Zener Diode” },
“opamp”:                 { id: 696,  name: “Op-Amp”,                      paramLabel: “Operational Amplifier” },
“comparator”:            { id: 697,  name: “Comparator”,                  paramLabel: “Comparator” },
“ldo”:                   { id: 701,  name: “LDO Voltage Regulator”,       paramLabel: “LDO Regulator” },
“dcdc_buck”:             { id: 706,  name: “Buck DC-DC Converter”,        paramLabel: “DC-DC Buck” },
“gate_driver”:           { id: 712,  name: “Gate Driver”,                 paramLabel: “Gate Driver” },
“voltage_ref”:           { id: 702,  name: “Voltage Reference”,           paramLabel: “Voltage Reference” },
“cap_ceramic”:           { id: 399,  name: “Ceramic Capacitor”,           paramLabel: “Ceramic Capacitor” },
“cap_electrolytic”:      { id: 406,  name: “Electrolytic Capacitor”,      paramLabel: “Electrolytic Capacitor” },
“cap_tantalum”:          { id: 408,  name: “Tantalum Capacitor”,          paramLabel: “Tantalum Capacitor” },
“cap_film”:              { id: 404,  name: “Film Capacitor”,              paramLabel: “Film Capacitor” },
“inductor”:              { id: 389,  name: “Power Inductor”,              paramLabel: “Inductor” },
“resistor_smd”:          { id: 411,  name: “SMD Resistor”,               paramLabel: “Chip Resistor” },
“current_sensor”:        { id: 730,  name: “Current Sensor”,             paramLabel: “Current Sensor” },
“temp_sensor”:           { id: 727,  name: “Temperature Sensor”,         paramLabel: “Temperature Sensor” },
};

// =============================================
// COMPONENT TYPE DETECTOR
// Maps keywords to DK category keys
// Order matters - more specific checks first
// =============================================
function detectComponentType(query) {
var q = query.toLowerCase();

// Remove application words that confuse detection
// e.g. “MOSFET for motor driver” - “motor driver” should not trigger gate_driver
q = q.replace(/for\s+(motor|pfc|inverter|converter|charger|driver|controller|amplifier|supply|circuit|switching|drive|load|battery|solar|wind|power)[^,]*/g, “”);
q = q.replace(/in\s+(motor|pfc|inverter|converter|charger|driver|controller|amplifier|supply|circuit|switching|drive|load|battery|solar|wind|power)[^,]*/g, “”);

// IGBT first (before MOSFET - more specific)
if (q.includes(“igbt”)) return “igbt”;

// MOSFET
if (q.includes(“mosfet”) || q.includes(” fet”) || q.includes(“nmos”) || q.includes(“pmos”)) {
if (q.includes(“p-channel”) || q.includes(“p channel”) || q.includes(“pmos”) || q.includes(“p type”)) return “mosfet_p”;
return “mosfet_n”;
}

// BJT transistor
if (q.includes(“pnp”)) return “bjt_pnp”;
if (q.includes(“npn”) || (q.includes(“bjt”) && !q.includes(“pnp”)) || (q.includes(“transistor”) && !q.includes(“mosfet”) && !q.includes(“fet”))) return “bjt_npn”;

// Diodes
if (q.includes(“schottky”)) return “diode_schottky”;
if (q.includes(“zener”)) return “diode_zener”;
if (q.includes(“diode”) || q.includes(“rectifier”)) return “diode_rectifier”;

// Gate driver (explicit only - not “motor driver”)
if (q.includes(“gate driver”) || q.includes(“gate drive ic”) || q.includes(“mosfet driver ic”) || q.includes(“half bridge driver”) || q.includes(“full bridge driver”)) return “gate_driver”;

// Op-amp
if (q.includes(“op-amp”) || q.includes(“opamp”) || q.includes(“op amp”) || q.includes(“operational amplifier”)) return “opamp”;

// Comparator
if (q.includes(“comparator”)) return “comparator”;

// Voltage reference
if (q.includes(“voltage reference”) || q.includes(“vref”) || q.includes(“reference ic”)) return “voltage_ref”;

// LDO / linear regulator
if (q.includes(“ldo”) || q.includes(“linear regulator”) || (q.includes(“regulator”) && !q.includes(“switching”) && !q.includes(“buck”) && !q.includes(“boost”) && !q.includes(“dc-dc”))) return “ldo”;

// DC-DC converter
if (q.includes(“dc-dc”) || q.includes(“dcdc”) || q.includes(“buck converter”) || q.includes(“boost converter”) || q.includes(“switching regulator”) || q.includes(“buck ic”) || q.includes(“boost ic”)) return “dcdc_buck”;

// Capacitors - check before generic “cap”
if (q.includes(“electrolytic”) || q.includes(“aluminum capacitor”) || q.includes(“aluminium capacitor”)) return “cap_electrolytic”;
if (q.includes(“tantalum”)) return “cap_tantalum”;
if (q.includes(“film capacitor”)) return “cap_film”;
if (q.includes(“ceramic”) || q.includes(“mlcc”)) return “cap_ceramic”;
if (q.includes(“capacitor”) || q.match(/\d+\s*(uf|nf|pf)\b/)) {
// Guess type from voltage
var capVoltMatch = q.match(/(\d+)\s*v/);
var capV = capVoltMatch ? parseInt(capVoltMatch[1]) : 0;
if (capV > 50) return “cap_electrolytic”;
return “cap_ceramic”;
}

// Inductors
if (q.includes(“inductor”) || q.includes(“choke”) || q.match(/\d+\s*(uh|nh|mh)\b/)) return “inductor”;

// Resistors
if (q.includes(“resistor”) || q.match(/\d+\s*(ohm|kohm|mohm)\b/)) return “resistor_smd”;

// Sensors
if (q.includes(“current sensor”) || q.includes(“current sense”) || q.includes(“hall effect current”)) return “current_sensor”;
if (q.includes(“temperature sensor”) || q.includes(“temp sensor”)) return “temp_sensor”;

return null;
}

// =============================================
// DIGIKEY PARAMETRIC FILTERS
// Maps required specs to DigiKey filter parameters
// =============================================
function buildParametricFilters(componentType, specs) {
var filters = [];

// MOSFET / IGBT
if (componentType === “mosfet_n” || componentType === “mosfet_p” || componentType === “igbt”) {
if (specs.voltage) {
// Vds minimum = requested voltage (we want >= reqV)
// DigiKey filter for min value uses negative offset approach
// We filter after getting results for exact spec matching
// Just pass the voltage as a keyword hint - category does the heavy lifting
}
}

// No parametric filters needed - category + in-stock + sort is sufficient
// We do spec filtering after receiving results
return filters;
}

// =============================================
// DIGIKEY CATEGORY SEARCH
// Uses ONLY category ID - no keywords to avoid pollution
// =============================================
async function searchByCategory(categoryKey, specs, limit) {
try {
var fetch = (await import(“node-fetch”)).default;
var token = await getDigikeyToken();
if (!token) return null;

```
var cat = DK_CATEGORIES[categoryKey];
if (!cat) return null;

limit = limit || 50;

var body = {
  Keywords: "",
  Limit: limit,
  Offset: 0,
  FilterOptionsRequest: {
    InStock: true,
  },
  CategoryFilter: {
    CategoryId: cat.id,
  },
  SortOptions: {
    Field: "QuantityAvailable",
    SortOrder: "Descending",
  },
};

console.log("DigiKey category search: " + cat.name + " (id=" + cat.id + ")");

var res = await fetch("https://api.digikey.com/products/v4/search/keyword", {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + token,
    "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID,
    "X-DIGIKEY-Locale-Site": "US",
    "X-DIGIKEY-Locale-Language": "en",
    "X-DIGIKEY-Locale-Currency": "USD",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

if (!res.ok) {
  var errText = await res.text();
  console.error("DigiKey category search failed:", res.status, errText.substring(0, 300));
  return null;
}

var data = await res.json();
var products = data.Products || [];
console.log("DigiKey returned", products.length, "products for category", cat.name);
return products;
```

} catch (e) {
console.error(“DigiKey category search error:”, e.message);
return null;
}
}

// =============================================
// SINGLE PART LOOKUP ON DIGIKEY
// =============================================
async function lookupDigikey(mpn) {
try {
var fetch = (await import(“node-fetch”)).default;
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
return { found: true, stock: product.QuantityAvailable || 0, price: unitPrice ? “$” + parseFloat(unitPrice).toFixed(3) : null, url: product.ProductUrl || “”, matchedPart: product.ManufacturerProductNumber || mpn };
}
var res2 = await fetch(“https://api.digikey.com/products/v4/search/keyword”, {
method: “POST”,
headers: { “Authorization”: “Bearer “ + token, “X-DIGIKEY-Client-Id”: process.env.DIGIKEY_CLIENT_ID, “X-DIGIKEY-Locale-Site”: “US”, “X-DIGIKEY-Locale-Language”: “en”, “X-DIGIKEY-Locale-Currency”: “USD”, “Content-Type”: “application/json” },
body: JSON.stringify({ Keywords: mpn, Limit: 5, Offset: 0 }),
});
if (!res2.ok) return null;
var data2 = await res2.json();
var products = data2.Products || [];
if (products.length === 0) return null;
var best = products.reduce(function(a, b) { return (b.QuantityAvailable || 0) > (a.QuantityAvailable || 0) ? b : a; });
var unitPrice2 = best.UnitPrice || (best.StandardPricing && best.StandardPricing[0] && best.StandardPricing[0].UnitPrice) || null;
return { found: true, stock: best.QuantityAvailable || 0, price: unitPrice2 ? “$” + parseFloat(unitPrice2).toFixed(3) : null, url: best.ProductUrl || “”, matchedPart: best.ManufacturerProductNumber || mpn };
} catch (e) { console.error(“DK lookup failed for “ + mpn + “:”, e.message); return null; }
}

// =============================================
// MOUSER LOOKUP
// =============================================
async function lookupMouser(mpn) {
try {
var fetch = (await import(“node-fetch”)).default;
var res = await fetch(“https://api.mouser.com/api/v1/search/partnumber?apiKey=” + process.env.MOUSER_API_KEY, {
method: “POST”,
headers: { “Content-Type”: “application/json” },
body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: “Begins With” } }),
});
var data = res.ok ? await res.json() : null;
var parts = (data && data.SearchResults && data.SearchResults.Parts) || [];
if (parts.length === 0) {
var res2 = await fetch(“https://api.mouser.com/api/v1/search/keyword?apiKey=” + process.env.MOUSER_API_KEY, {
method: “POST”,
headers: { “Content-Type”: “application/json” },
body: JSON.stringify({ SearchByKeywordRequest: { keyword: mpn, records: 5, startingRecord: 0, searchOptions: “BeginsWith” } }),
});
var data2 = res2.ok ? await res2.json() : null;
parts = (data2 && data2.SearchResults && data2.SearchResults.Parts) || [];
}
if (parts.length === 0) return null;
var best = parts.reduce(function(a, b) {
return (parseInt((b.Availability || “0”).replace(/[^0-9]/g, “”)) || 0) > (parseInt((a.Availability || “0”).replace(/[^0-9]/g, “”)) || 0) ? b : a;
});
var stock = parseInt((best.Availability || “0”).replace(/[^0-9]/g, “”)) || 0;
var price = best.PriceBreaks && best.PriceBreaks[0] && best.PriceBreaks[0].Price;
return { found: true, stock: stock, price: price || null, url: best.ProductDetailUrl || “”, matchedPart: best.ManufacturerPartNumber || mpn };
} catch (e) { console.error(“Mouser lookup failed for “ + mpn + “:”, e.message); return null; }
}

// =============================================
// PREFETCH STOCK FROM BOTH DISTRIBUTORS
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
if (dk && dk.price) { bestPrice = dk.price; bestPriceSource = “Digi-Key”; }
if (mouser && mouser.price) {
var mv = parseFloat((mouser.price || “999”).replace(/[^0-9.]/g, “”)) || 999;
var cv = parseFloat((bestPrice || “999”).replace(/[^0-9.]/g, “”)) || 999;
if (mv < cv) { bestPrice = mouser.price; bestPriceSource = “Mouser”; }
}
var sr = { found: total > 0, totalStock: total, bestPrice: bestPrice, bestPriceSource: bestPriceSource, digikey: dk, mouser: mouser, octopartUrl: “https://octopart.com/search?q=” + encodeURIComponent(mpn) };
setCache(stockCache, mpn, sr, STOCK_TTL);
stockResults[mpn] = sr;
console.log(”  Stock”, mpn, “DK:”, dk ? dk.stock : “N/A”, “MO:”, mouser ? mouser.stock : “N/A”);
}
return stockResults;
}

// =============================================
// EXTRACT SPECS FROM DIGIKEY PRODUCT PARAMETERS
// Returns numeric spec values from parameter list
// =============================================
function extractSpecsFromParameters(parameters) {
var specs = {};
if (!parameters || !Array.isArray(parameters)) return specs;

for (var i = 0; i < parameters.length; i++) {
var name = (parameters[i].Parameter || “”).toLowerCase();
var raw = (parameters[i].Value || “”).toLowerCase();
var num = parseFloat(raw.replace(/[^0-9.]/g, “”));

```
// Voltage specs
if ((name.includes("drain to source") || name.includes("vdss") || name.includes("vds")) && !isNaN(num)) specs.voltage = num;
else if ((name.includes("collector emitter breakdown") || name.includes("vce") || name.includes("vceo")) && !isNaN(num) && !specs.voltage) specs.voltage = num;
else if ((name.includes("voltage - peak reverse") || name.includes("vrrm")) && !isNaN(num) && !specs.voltage) specs.voltage = num;
else if ((name.includes("voltage - input (max)") || name.includes("vin max")) && !isNaN(num) && !specs.vin) specs.vin = num;
else if ((name.includes("voltage - output") || name.includes("vout")) && !isNaN(num) && !specs.vout) {
  // Handle ranges like "1.2V ~ 37V" - take first number
  specs.vout = parseFloat((parameters[i].Value || "").replace(/[^0-9.]/g, ""));
}
else if ((name.includes("voltage rated") || name.includes("voltage - rated")) && !isNaN(num) && !specs.voltage) specs.voltage = num;

// Current specs
else if ((name.includes("continuous drain") || name.includes("id)") || name.includes("drain current")) && !isNaN(num)) specs.current = num;
else if ((name.includes("collector") && name.includes("current") && name.includes("max")) && !isNaN(num) && !specs.current) specs.current = num;
else if ((name.includes("current - output") || name.includes("iout") || name.includes("output current")) && !isNaN(num) && !specs.current) specs.current = num;
else if ((name.includes("current - average rectified") || name.includes("io)")) && !isNaN(num) && !specs.current) specs.current = num;
else if ((name.includes("current rating") || name.includes("irated")) && !isNaN(num) && !specs.current) specs.current = num;

// Resistance specs
else if ((name.includes("rds on") || name.includes("rds(on)")) && !isNaN(num)) {
  // Normalize to mOhm
  if (raw.includes("mohm") || raw.includes("m\u03a9") || raw.includes("milliohm")) specs.rds = num;
  else if (raw.includes("kohm")) specs.rds = num * 1000000;
  else specs.rds = num * 1000; // assume Ohm -> convert to mOhm
}
else if ((name.includes("dc resistance") || name.includes("dcr")) && !isNaN(num)) specs.dcr = num;

// Power
else if ((name.includes("power dissipation") || name.includes("pd") || name.includes("ptot")) && !isNaN(num)) specs.power = num;

// Capacitance
else if (name === "capacitance" && !isNaN(num)) {
  if (raw.includes("uf") || raw.includes("\u00b5f")) specs.capacitance = num;
  else if (raw.includes("nf")) specs.capacitance = num / 1000;
  else if (raw.includes("pf")) specs.capacitance = num / 1000000;
  else specs.capacitance = num;
}

// Inductance
else if (name === "inductance" && !isNaN(num)) {
  if (raw.includes("uh") || raw.includes("\u00b5h")) specs.inductance = num;
  else if (raw.includes("nh")) specs.inductance = num / 1000;
  else if (raw.includes("mh")) specs.inductance = num * 1000;
  else specs.inductance = num;
}

// GBW for op-amps
else if ((name.includes("gain bandwidth") || name.includes("gbw") || name.includes("gbp")) && !isNaN(num)) {
  if (raw.includes("mhz")) specs.gbw = num;
  else if (raw.includes("khz")) specs.gbw = num / 1000;
  else specs.gbw = num;
}

// Dropout for LDOs
else if ((name.includes("dropout") || name.includes("vdo")) && !isNaN(num)) {
  if (raw.includes("mv")) specs.dropout = num;
  else specs.dropout = num * 1000; // V to mV
}

// Forward voltage
else if ((name.includes("forward voltage") || name.includes("vf")) && !isNaN(num)) specs.vf = num;

// Frequency
else if ((name.includes("frequency") && !name.includes("self resonant")) && !isNaN(num)) {
  if (raw.includes("mhz")) specs.freq = num;
  else if (raw.includes("khz")) specs.freq = num / 1000;
  else specs.freq = num;
}
```

}

return specs;
}

// =============================================
// BUILD KEY SPECS ARRAY FOR FRONTEND
// Component-type-aware spec display
// =============================================
function buildKeySpecs(parameters, productSpecs, componentType, product) {
var keySpecs = [];
var pkg = (product && product.PackageType) || “”;

if (componentType === “mosfet_n” || componentType === “mosfet_p” || componentType === “igbt”) {
if (productSpecs.voltage) keySpecs.push({ label: “VDS”, value: String(productSpecs.voltage), unit: “V” });
if (productSpecs.current) keySpecs.push({ label: “ID”, value: String(productSpecs.current), unit: “A” });
if (productSpecs.rds) keySpecs.push({ label: “RDS(on)”, value: productSpecs.rds < 1 ? String(Math.round(productSpecs.rds * 10) / 10) : String(Math.round(productSpecs.rds)), unit: “m\u03a9” });
if (productSpecs.power) keySpecs.push({ label: “Pd”, value: String(productSpecs.power), unit: “W” });
if (pkg) keySpecs.push({ label: “Package”, value: pkg, unit: “” });
} else if (componentType === “bjt_npn” || componentType === “bjt_pnp”) {
if (productSpecs.voltage) keySpecs.push({ label: “Vce”, value: String(productSpecs.voltage), unit: “V” });
if (productSpecs.current) keySpecs.push({ label: “Ic”, value: String(productSpecs.current), unit: “A” });
if (productSpecs.power) keySpecs.push({ label: “Pd”, value: String(productSpecs.power), unit: “W” });
if (pkg) keySpecs.push({ label: “Package”, value: pkg, unit: “” });
} else if (componentType === “diode_rectifier” || componentType === “diode_schottky”) {
if (productSpecs.voltage) keySpecs.push({ label: “Vrrm”, value: String(productSpecs.voltage), unit: “V” });
if (productSpecs.current) keySpecs.push({ label: “Io”, value: String(productSpecs.current), unit: “A” });
if (productSpecs.vf) keySpecs.push({ label: “Vf”, value: String(productSpecs.vf), unit: “V” });
if (pkg) keySpecs.push({ label: “Package”, value: pkg, unit: “” });
} else if (componentType === “diode_zener”) {
if (productSpecs.voltage) keySpecs.push({ label: “Vz”, value: String(productSpecs.voltage), unit: “V” });
if (productSpecs.power) keySpecs.push({ label: “Pz”, value: String(productSpecs.power), unit: “W” });
if (pkg) keySpecs.push({ label: “Package”, value: pkg, unit: “” });
} else if (componentType === “opamp”) {
if (productSpecs.gbw) keySpecs.push({ label: “GBW”, value: String(productSpecs.gbw), unit: “MHz” });
if (productSpecs.vin) keySpecs.push({ label: “Vcc Max”, value: String(productSpecs.vin), unit: “V” });
if (pkg) keySpecs.push({ label: “Package”, value: pkg, unit: “” });
} else if (componentType === “ldo”) {
if (productSpecs.vout) keySpecs.push({ label: “Vout”, value: String(productSpecs.vout), unit: “V” });
if (productSpecs.current) keySpecs.push({ label: “Iout”, value: String(productSpecs.current), unit: “A” });
if (productSpecs.vin) keySpecs.push({ label: “Vin Max”, value: String(productSpecs.vin), unit: “V” });
if (productSpecs.dropout) keySpecs.push({ label: “Dropout”, value: String(productSpecs.dropout), unit: “mV” });
if (pkg) keySpecs.push({ label: “Package”, value: pkg, unit: “” });
} else if (componentType === “cap_ceramic” || componentType === “cap_electrolytic” || componentType === “cap_tantalum” || componentType === “cap_film”) {
if (productSpecs.capacitance) keySpecs.push({ label: “Cap”, value: productSpecs.capacitance >= 1 ? String(Math.round(productSpecs.capacitance * 100) / 100) : String(Math.round(productSpecs.capacitance * 100000) / 100), unit: productSpecs.capacitance >= 1 ? “uF” : “nF” });
if (productSpecs.voltage) keySpecs.push({ label: “Voltage”, value: String(productSpecs.voltage), unit: “V” });
if (pkg) keySpecs.push({ label: “Package”, value: pkg, unit: “” });
} else if (componentType === “inductor”) {
if (productSpecs.inductance) keySpecs.push({ label: “L”, value: productSpecs.inductance >= 1 ? String(Math.round(productSpecs.inductance * 10) / 10) : String(Math.round(productSpecs.inductance * 1000)), unit: productSpecs.inductance >= 1 ? “uH” : “nH” });
if (productSpecs.current) keySpecs.push({ label: “Irated”, value: String(productSpecs.current), unit: “A” });
if (productSpecs.dcr) keySpecs.push({ label: “DCR”, value: String(Math.round(productSpecs.dcr * 10) / 10), unit: “m\u03a9” });
if (pkg) keySpecs.push({ label: “Package”, value: pkg, unit: “” });
} else {
// Generic - grab first 4 numeric params
var count = 0;
for (var i = 0; i < parameters.length && count < 4; i++) {
var v = parseFloat(parameters[i].Value || “”);
if (!isNaN(v)) {
keySpecs.push({ label: parameters[i].Parameter || “”, value: String(v), unit: “” });
count++;
}
}
if (pkg) keySpecs.push({ label: “Package”, value: pkg, unit: “” });
}

return keySpecs;
}

// =============================================
// FILTER PRODUCTS BY REQUIRED SPECS
// All filtering is exact - no AI guessing
// =============================================
function filterBySpecs(products, requiredSpecs, componentType) {
if (!requiredSpecs || Object.keys(requiredSpecs).length === 0) return products;

var TOLERANCE = 0.95; // 5% tolerance for minimum specs

return products.filter(function(p) {
var ps = p._specs || {};

```
// Voltage check (must meet or exceed)
if (requiredSpecs.voltage && ps.voltage) {
  if (ps.voltage < requiredSpecs.voltage * TOLERANCE) {
    return false;
  }
}

// Current check (must meet or exceed)
if (requiredSpecs.current && ps.current) {
  if (ps.current < requiredSpecs.current * TOLERANCE) {
    return false;
  }
}
if (requiredSpecs.currentMA && ps.current) {
  if (ps.current * 1000 < requiredSpecs.currentMA * TOLERANCE) {
    return false;
  }
}

// Capacitance check (within 30% - standard cap tolerances are wide)
if (requiredSpecs.capacitanceUF && ps.capacitance) {
  if (Math.abs(ps.capacitance - requiredSpecs.capacitanceUF) / requiredSpecs.capacitanceUF > 0.30) {
    return false;
  }
}
if (requiredSpecs.capacitanceNF && ps.capacitance) {
  var reqUF = requiredSpecs.capacitanceNF / 1000;
  if (Math.abs(ps.capacitance - reqUF) / reqUF > 0.30) {
    return false;
  }
}

// Inductance check (within 25%)
if (requiredSpecs.inductanceUH && ps.inductance) {
  if (Math.abs(ps.inductance - requiredSpecs.inductanceUH) / requiredSpecs.inductanceUH > 0.25) {
    return false;
  }
}

// GBW check for op-amps (must meet or exceed)
if (requiredSpecs.gbwMHz && ps.gbw) {
  if (ps.gbw < requiredSpecs.gbwMHz * TOLERANCE) {
    return false;
  }
}

// Dropout check for LDOs (must be <= required)
if (requiredSpecs.dropoutMV && ps.dropout) {
  if (ps.dropout > requiredSpecs.dropoutMV * 1.05) {
    return false;
  }
}

return true;
```

});
}

// =============================================
// SCORE CLOSENESS TO REQUESTED SPECS
// Lower score = closer match = better ranking
// =============================================
function scoreCloseness(productSpecs, requiredSpecs, componentType) {
var score = 0;
var checked = 0;

// For min specs: score = (partVal - reqVal) / reqVal
// Perfect match = 0, 2x over-rated = 1.0
function minScore(partVal, reqVal) {
if (!partVal || !reqVal) return 0;
var ratio = (partVal - reqVal) / reqVal;
return Math.max(0, ratio);
}

// For exact specs: score = abs(partVal - reqVal) / reqVal
function exactScore(partVal, reqVal) {
if (!partVal || !reqVal) return 0;
return Math.abs(partVal - reqVal) / reqVal;
}

if (componentType === “mosfet_n” || componentType === “mosfet_p” || componentType === “igbt”) {
if (requiredSpecs.voltage && productSpecs.voltage) { score += minScore(productSpecs.voltage, requiredSpecs.voltage); checked++; }
if (requiredSpecs.current && productSpecs.current) { score += minScore(productSpecs.current, requiredSpecs.current); checked++; }
} else if (componentType === “opamp”) {
if (requiredSpecs.gbwMHz && productSpecs.gbw) { score += minScore(productSpecs.gbw, requiredSpecs.gbwMHz); checked++; }
} else if (componentType === “ldo”) {
if (requiredSpecs.outputV && productSpecs.vout) { score += exactScore(productSpecs.vout, requiredSpecs.outputV) * 2; checked++; }
if (requiredSpecs.current && productSpecs.current) { score += minScore(productSpecs.current, requiredSpecs.current); checked++; }
} else if (componentType === “cap_ceramic” || componentType === “cap_electrolytic” || componentType === “cap_tantalum” || componentType === “cap_film”) {
if (requiredSpecs.capacitanceUF && productSpecs.capacitance) { score += exactScore(productSpecs.capacitance, requiredSpecs.capacitanceUF) * 3; checked++; }
if (requiredSpecs.voltage && productSpecs.voltage) { score += minScore(productSpecs.voltage, requiredSpecs.voltage); checked++; }
} else if (componentType === “inductor”) {
if (requiredSpecs.inductanceUH && productSpecs.inductance) { score += exactScore(productSpecs.inductance, requiredSpecs.inductanceUH) * 3; checked++; }
if (requiredSpecs.current && productSpecs.current) { score += minScore(productSpecs.current, requiredSpecs.current); checked++; }
} else if (componentType === “diode_rectifier” || componentType === “diode_schottky”) {
if (requiredSpecs.voltage && productSpecs.voltage) { score += minScore(productSpecs.voltage, requiredSpecs.voltage); checked++; }
if (requiredSpecs.current && productSpecs.current) { score += minScore(productSpecs.current, requiredSpecs.current); checked++; }
}

return checked > 0 ? score / checked : 999;
}

// =============================================
// CONVERT DIGIKEY PRODUCT TO OUR FORMAT
// =============================================
function convertProduct(product, componentType) {
var parameters = product.Parameters || [];
var productSpecs = extractSpecsFromParameters(parameters);
var keySpecs = buildKeySpecs(parameters, productSpecs, componentType, product);
var description = (product.Description && product.Description.ProductDescription) || “”;
var unitPrice = product.UnitPrice || (product.StandardPricing && product.StandardPricing[0] && product.StandardPricing[0].UnitPrice) || null;
var cat = DK_CATEGORIES[componentType];

return {
partNumber: product.ManufacturerProductNumber || “”,
manufacturer: (product.Manufacturer && product.Manufacturer.Name) || “”,
type: (cat && cat.name) || description.split(” “).slice(0, 3).join(” “),
description: description,
package: product.PackageType || “”,
keySpecs: keySpecs,
dkStock: product.QuantityAvailable || 0,
dkPrice: unitPrice ? “$” + parseFloat(unitPrice).toFixed(3) : null,
dkUrl: product.ProductUrl || “”,
rank: “alternative”,
aeComment: “”,
caution: null,
applications: [],
_specs: productSpecs, // internal use for sorting/filtering
};
}

// =============================================
// EXTRACT REQUIRED SPECS FROM QUERY
// =============================================
function extractRequiredSpecs(query) {
var lower = query.toLowerCase();
var specs = {};

// Voltage
var vMatches = lower.match(/(\d+(?:.\d+)?)\s*v\b/gi) || [];
if (vMatches.length > 0) {
var volts = vMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; });
if (volts.length > 0) specs.voltage = Math.max.apply(null, volts);
}
// Current - A
var aMatches = lower.match(/(\d+(?:.\d+)?)\s*a\b/gi) || [];
if (aMatches.length > 0) {
var amps = aMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; });
if (amps.length > 0) specs.current = Math.max.apply(null, amps);
}
// Current - mA
var maMatches = lower.match(/(\d+(?:.\d+)?)\s*ma\b/gi) || [];
if (maMatches.length > 0 && !specs.current) {
var mamps = maMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v); });
if (mamps.length > 0) specs.currentMA = Math.max.apply(null, mamps);
}
// Power
var wMatches = lower.match(/(\d+(?:.\d+)?)\s*w\b/gi) || [];
if (wMatches.length > 0) {
var watts = wMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0.1; });
if (watts.length > 0) specs.power = Math.max.apply(null, watts);
}
// Capacitance
var ufM = lower.match(/(\d+(?:.\d+)?)\s*uf\b/gi) || [];
if (ufM.length > 0) specs.capacitanceUF = parseFloat(ufM[0]);
var nfM = lower.match(/(\d+(?:.\d+)?)\s*nf\b/gi) || [];
if (nfM.length > 0 && !specs.capacitanceUF) specs.capacitanceNF = parseFloat(nfM[0]);
var pfM = lower.match(/(\d+(?:.\d+)?)\s*pf\b/gi) || [];
if (pfM.length > 0 && !specs.capacitanceUF && !specs.capacitanceNF) specs.capacitancePF = parseFloat(pfM[0]);
// Inductance
var uhM = lower.match(/(\d+(?:.\d+)?)\s*uh\b/gi) || [];
if (uhM.length > 0) specs.inductanceUH = parseFloat(uhM[0]);
var nhM = lower.match(/(\d+(?:.\d+)?)\s*nh\b/gi) || [];
if (nhM.length > 0 && !specs.inductanceUH) specs.inductanceNH = parseFloat(nhM[0]);
// GBW / Bandwidth
var mhzM = lower.match(/(\d+(?:.\d+)?)\s*mhz\b/gi) || [];
if (mhzM.length > 0 && (lower.includes(“gbw”) || lower.includes(“bandwidth”))) specs.gbwMHz = parseFloat(mhzM[0]);
// Noise
var nvM = lower.match(/(\d+(?:.\d+)?)\s*nv\b/gi) || [];
if (nvM.length > 0) specs.noiseNV = parseFloat(nvM[0]);
// Dropout
var mvM = lower.match(/(\d+(?:.\d+)?)\s*mv\b/gi) || [];
if (mvM.length > 0 && (lower.includes(“dropout”) || lower.includes(“ldo”))) specs.dropoutMV = parseFloat(mvM[0]);
// Output voltage for LDO
var voutM = lower.match(/(\d+(?:.\d+)?)\s*v\s*(?:output|ldo|out)/i) || lower.match(/(?:output|ldo|out)\s*(\d+(?:.\d+)?)\s*v/i) || [];
if (voutM && voutM[1]) specs.outputV = parseFloat(voutM[1]);

console.log(“Required specs:”, JSON.stringify(specs));
return specs;
}

// =============================================
// EXTRACT JSON FROM AI RESPONSE
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
var fetch = (await import(“node-fetch”)).default;
var models = [“claude-sonnet-4-20250514”, “claude-haiku-4-5-20251001”];
for (var attempt = 1; attempt <= 3; attempt++) {
var model = attempt <= 2 ? models[0] : models[1];
try {
var aiRes = await fetch(“https://api.anthropic.com/v1/messages”, {
method: “POST”,
headers: { “Content-Type”: “application/json”, “x-api-key”: process.env.ANTHROPIC_API_KEY, “anthropic-version”: “2023-06-01” },
body: JSON.stringify({ model: model, max_tokens: maxTokens || 3000, system: system, messages: messages }),
});
var aiData = await aiRes.json();
if (aiData.error && aiData.error.type === “overloaded_error”) { await new Promise(function(r) { setTimeout(r, attempt * 3000); }); continue; }
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
// SYSTEM PROMPTS
// =============================================
var INTENT_SYSTEM = “You classify hardware engineering queries. Consider the full conversation context. If the new message is a follow-up refinement (like ‘only in stock’, ‘cheaper’, ‘different package’, ‘find alternatives’), classify it as the SAME intent as the previous turn.\n\nCRITICAL: Any message asking for a component, part, chip, MOSFET, op-amp, capacitor, inductor, resistor, diode, regulator, sensor, or any electronic part MUST be classified as part_search. Never classify component requests as circuit_question or general.\n\nRespond ONLY with JSON:\n{"intent":"part_search|find_alternatives|generate_bom|circuit_question|calculation|correction|general","partNumber":"extracted part number or null","needsMoreInfo":false,"followUpQuestion":null}”;

var ENGINEERING_SYSTEM = “You are PartTensor, a senior hardware application engineer AI. Help engineers with circuit design, calculations, and troubleshooting. Be direct, technical and precise. Use real formulas and examples. Format with **bold headers** and - bullet points.”;

var ENRICHMENT_SYSTEM = “You are a senior application engineer. You are given real parts from DigiKey. Your job is ONLY to:\n1. Rank them: first = ‘top’, second = ‘good’, rest = ‘alternative’\n2. Write a brief aeComment for each (1-2 sentences, why it is or is not ideal)\n3. Add caution note if relevant\n4. Add applications array\n5. Write one designTip\n6. Write category and interpretation\n\nDO NOT change any part numbers or specs. DO NOT suggest different parts.\nRespond ONLY with raw JSON starting with {:\n{"category":"N-Channel MOSFET","interpretation":"one sentence","designTip":"tip","rankedResults":[{"partNumber":"IRF540NPBF","rank":"top","aeComment":"reason","caution":null,"applications":["Motor Drive"]}]}”;

var BOM_SYSTEM = “You are a senior hardware application engineer. Generate a smart Bill of Materials. Only critical components: MOSFETs, ICs, drivers, specialized inductors, electrolytic caps, current sense resistors, crystals, connectors, optocouplers, diodes, sensors. NO generic resistors, 100nF caps, generic LEDs. Use full Digi-Key part numbers. 5 keySpecs per part.\nRespond ONLY with raw JSON starting with {:\n{"bomItems":[{"id":1,"function":"Gate Driver","partNumber":"IR2184SPBF","manufacturer":"Infineon","description":"one line","category":"IC","quantity":1,"keySpecs":"600V 2A SO-8","package":"SO-8","priority":"critical","unitPrice":"$1.20","notes":null}],"projectName":"name","description":"sentence","voltage":"V","power":"W","designNotes":"notes","totalEstimate":"$15-25"}”;

var PASSIVE_KEYWORDS = [“connector”,“receptacle”,“plug”,“socket”,“jack”,“header”,“terminal”,“coax”,“mmcx”,“sma”,“bnc”,“usb “,“hdmi”,“crystal”,“resonator”,“transformer”,“relay”,“switch”,“fuse”,“varistor”,“thermistor”,“potentiometer”,“antenna”,“balun”];
function isPassiveConnector(description, categoryName) {
var text = ((description || “”) + “ “ + (categoryName || “”)).toLowerCase();
for (var i = 0; i < PASSIVE_KEYWORDS.length; i++) { if (text.indexOf(PASSIVE_KEYWORDS[i]) !== -1) return true; }
return false;
}

async function fetchPartSpecs(mpn) {
try {
var fetch = (await import(“node-fetch”)).default;
var token = await getDigikeyToken();
if (!token) return null;
var res = await fetch(“https://api.digikey.com/products/v4/search/” + encodeURIComponent(mpn) + “/productdetails”, { method: “GET”, headers: { “Authorization”: “Bearer “ + token, “X-DIGIKEY-Client-Id”: process.env.DIGIKEY_CLIENT_ID, “X-DIGIKEY-Locale-Site”: “US”, “X-DIGIKEY-Locale-Language”: “en”, “X-DIGIKEY-Locale-Currency”: “USD” } });
var product = null;
if (res.ok) { var data = await res.json(); product = data.Product || data; }
else {
var res2 = await fetch(“https://api.digikey.com/products/v4/search/keyword”, { method: “POST”, headers: { “Authorization”: “Bearer “ + token, “X-DIGIKEY-Client-Id”: process.env.DIGIKEY_CLIENT_ID, “X-DIGIKEY-Locale-Site”: “US”, “X-DIGIKEY-Locale-Language”: “en”, “X-DIGIKEY-Locale-Currency”: “USD”, “Content-Type”: “application/json” }, body: JSON.stringify({ Keywords: mpn, Limit: 3, Offset: 0 }) });
if (!res2.ok) return null;
var data2 = await res2.json();
var prods = data2.Products || [];
if (prods.length === 0) return null;
product = prods[0];
}
if (!product) return null;
var parameters = product.Parameters || [];
var specs = extractSpecsFromParameters(parameters);
var specLines = parameters.slice(0, 15).map(function(p) { return p.Parameter + “: “ + p.Value; });
var description = (product.Description && product.Description.ProductDescription) || “”;
var categoryName = (product.Category && product.Category.Name) || “”;
var searchKeyword = description.replace(/[^a-zA-Z0-9\s]/g, “ “).split(/\s+/).filter(function(w) { return w.length > 2; }).slice(0, 5).join(” “);
return { mpn: product.ManufacturerProductNumber || mpn, manufacturer: (product.Manufacturer && product.Manufacturer.Name) || “”, description: description, categoryName: categoryName, isPassive: isPassiveConnector(description, categoryName), specs: specs, specsText: specLines.join(”; “), dkSearchUrl: “https://www.digikey.com/en/products/result?keywords=” + encodeURIComponent(searchKeyword) + “&stock=1”, mouserSearchUrl: “https://www.mouser.com/Search/Refine?Keyword=” + encodeURIComponent(mpn) + “&inStock=1”, octopartUrl: “https://octopart.com/search?q=” + encodeURIComponent(mpn) + “&in_stock=1” };
} catch (e) { console.error(“fetchPartSpecs failed:”, e.message); return null; }
}

function buildAltSystem(originalPart) {
var s = originalPart.specs || {};
var lines = [];
if (s.voltage) lines.push(“Voltage >= “ + s.voltage + “V”);
if (s.current) lines.push(“Current >= “ + s.current + “A”);
if (s.rds) lines.push(“Rds(on) <= “ + s.rds + “mOhm”);
if (s.power) lines.push(“Power >= “ + s.power + “W”);
if (lines.length === 0) lines.push(“Match: “ + originalPart.specsText.substring(0, 150));
return “Find EXACTLY 4 alternatives for: “ + originalPart.mpn + “ by “ + originalPart.manufacturer + “ — “ + originalPart.description + “\nRequired specs: “ + lines.join(”, “) + “\nAll must meet or exceed. Real Digi-Key parts only. Different manufacturers.\nRespond ONLY with raw JSON starting with {:\n{"mode":"alt","originalPart":"” + originalPart.mpn + “","originalSpecs":"” + lines.join(”, “) + “","alternatives":[{"partNumber":"X","manufacturer":"Y","type":"N-Channel MOSFET","compatibility":"drop-in","keySpecs":[{"label":"VDS","value":"150","unit":"V"},{"label":"ID","value":"50","unit":"A"},{"label":"RDS(on)","value":"20","unit":"m\u03a9"},{"label":"Package","value":"TO-220","unit":""}],"package":"TO-220","whyAlternative":"reason","differences":"differences"}],"importantNote":"note"}”;
}

// =============================================
// HEALTH
// =============================================
app.get(”/api/health”, function(req, res) {
res.json({ status: “ok”, service: “PartTensor”, time: new Date().toISOString() });
});

// =============================================
// MAIN CHAT ENDPOINT
// =============================================
app.post(”/api/chat”, async function(req, res) {
try {
var message = req.body.message;
var history = req.body.history || [];
var isCorrection = req.body.isCorrection || false;
if (!message) return res.status(400).json({ error: “Message is required” });
console.log(”\n[CHAT]”, message.substring(0, 80));

```
var requiredSpecs = extractRequiredSpecs(message);

// Intent classification
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
console.log("Intent:", intent, "| PN:", detectedPN, "| Specs:", JSON.stringify(requiredSpecs));

if (needsMoreInfo && followUpQuestion && !isCorrection) return res.json({ text: followUpQuestion, intent: intent, mode: "question" });

var fullMessages = [];
history.slice(-8).forEach(function(m) { if (m.content) fullMessages.push({ role: m.role, content: m.content }); });
fullMessages.push({ role: "user", content: message });

// ENGINEERING QUESTIONS
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
  var originalPart = await fetchPartSpecs(pn);
  if (!originalPart) return res.json({ text: "Could not find **" + pn + "** on DigiKey. Please check the part number.", intent: intent, mode: "question" });
  if (originalPart.isPassive) {
    return res.json({ text: "For **" + pn + "** (" + originalPart.categoryName + "), use parametric search for the most accurate results.", mode: "passive_connector_alt", originalPart: pn, originalManufacturer: originalPart.manufacturer, originalDescription: originalPart.description, categoryName: originalPart.categoryName, searchLinks: [{ name: "Digi-Key Search", url: originalPart.dkSearchUrl, description: "Filter by specs" }, { name: "Mouser Search", url: originalPart.mouserSearchUrl, description: "In-stock alternatives" }, { name: "Octopart", url: originalPart.octopartUrl, description: "All distributors" }], tips: ["Category: " + originalPart.categoryName, originalPart.specsText.substring(0, 150)], intent: intent });
  }

  // Try DigiKey category search for real alternatives
  var altCompType = detectComponentType(originalPart.description + " " + originalPart.categoryName);
  var altDKProducts = altCompType ? await searchByCategory(altCompType, originalPart.specs, 50) : null;

  if (altDKProducts && altDKProducts.length > 0) {
    // Convert all products
    var altConverted = altDKProducts.map(function(p) { return convertProduct(p, altCompType); });

    // Remove original part
    altConverted = altConverted.filter(function(p) { return p.partNumber.toUpperCase() !== pn.toUpperCase(); });

    // Filter by specs
    altConverted = filterBySpecs(altConverted, originalPart.specs, altCompType);

    // Sort by closeness then stock
    altConverted = altConverted.sort(function(a, b) {
      var aIn = a.dkStock > 0 ? 1 : 0;
      var bIn = b.dkStock > 0 ? 1 : 0;
      if (bIn !== aIn) return bIn - aIn;
      var aScore = scoreCloseness(a._specs, originalPart.specs, altCompType);
      var bScore = scoreCloseness(b._specs, originalPart.specs, altCompType);
      if (Math.abs(aScore - bScore) > 0.05) return aScore - bScore;
      return b.dkStock - a.dkStock;
    });

    altConverted = altConverted.slice(0, 4);

    // Get Mouser stock for each
    var altStockMap = {};
    for (var ai = 0; ai < altConverted.length; ai++) {
      var mouser = await lookupMouser(altConverted[ai].partNumber);
      var total = altConverted[ai].dkStock + (mouser ? mouser.stock : 0);
      var bestPrice = altConverted[ai].dkPrice;
      var bestPriceSource = "Digi-Key";
      if (mouser && mouser.price) {
        var mv = parseFloat((mouser.price || "999").replace(/[^0-9.]/g, "")) || 999;
        var cv = parseFloat((bestPrice || "999").replace(/[^0-9.]/g, "")) || 999;
        if (mv < cv) { bestPrice = mouser.price; bestPriceSource = "Mouser"; }
      }
      var sdata = { found: total > 0, totalStock: total, bestPrice: bestPrice, bestPriceSource: bestPriceSource, digikey: { found: altConverted[ai].dkStock > 0, stock: altConverted[ai].dkStock, price: altConverted[ai].dkPrice, url: altConverted[ai].dkUrl }, mouser: mouser, octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(altConverted[ai].partNumber) };
      altStockMap[altConverted[ai].partNumber] = sdata;
      altConverted[ai].compatibility = "functional";
      altConverted[ai].whyAlternative = "Real DigiKey result meeting " + pn + " specs";
    }

    // AI enrichment
    var altEnrichPrompt = "User wants alternatives to " + pn + " (" + originalPart.description + "). Required: " + originalPart.specsText.substring(0, 200) + "\n\nReal DigiKey parts:\n" + altConverted.map(function(p, i) { return (i + 1) + ". " + p.partNumber + " (" + p.manufacturer + ") - " + p.keySpecs.map(function(s) { return s.label + "=" + s.value + s.unit; }).join(", ") + " - DK Stock: " + p.dkStock; }).join("\n");
    var altEnrich = await callAI(ENRICHMENT_SYSTEM, [{ role: "user", content: altEnrichPrompt }], 1500);
    if (altEnrich.text) {
      var altEnrichData = extractJSON(altEnrich.text);
      if (altEnrichData && altEnrichData.rankedResults) {
        altEnrichData.rankedResults.forEach(function(r) {
          altConverted.forEach(function(p) {
            if (p.partNumber === r.partNumber) { p.rank = r.rank || "alternative"; p.aeComment = r.aeComment || ""; p.caution = r.caution || null; p.applications = r.applications || []; }
          });
        });
        return res.json({ text: "Here are **" + altConverted.length + " alternatives** for **" + pn + "** sourced directly from DigiKey catalog:", mode: "alt", originalPart: pn, originalSpecs: originalPart.specsText.substring(0, 200), alternatives: altConverted, stockData: altStockMap, designTip: altEnrichData.designTip || "", importantNote: "All results sourced directly from DigiKey. Verify specs before ordering.", intent: intent });
      }
    }
    return res.json({ text: "Here are **" + altConverted.length + " alternatives** for **" + pn + "** from DigiKey:", mode: "alt", originalPart: pn, alternatives: altConverted, stockData: altStockMap, intent: intent });
  }

  // Fallback: AI picks alternatives
  var altAISys = buildAltSystem(originalPart);
  var altAIResult = await callAI(altAISys, [{ role: "user", content: message }], 3000);
  var altAIData = altAIResult.text ? extractJSON(altAIResult.text) : null;
  if (!altAIData) return res.json({ text: "Could not find alternatives for " + pn + ". Please try again.", intent: intent, mode: "text" });
  var altAIParts = altAIData.alternatives || [];
  var altAIStock = await prefetchStock(altAIParts.map(function(p) { return p.partNumber; }));
  altAIData.stockData = altAIStock;
  altAIData.mode = "alt";
  return res.json(Object.assign({ text: "Here are alternatives for **" + pn + "**:", intent: intent }, altAIData));
}

// GENERATE BOM
if (intent === "generate_bom") {
  var bomCacheKey = "bom:" + message.toLowerCase().trim();
  var cachedBOM = getCached(aiCache, bomCacheKey);
  if (cachedBOM) { console.log("BOM cache hit"); return res.json(cachedBOM); }
  var bomResult = await callAI(BOM_SYSTEM, fullMessages, 4000);
  var bomData = bomResult.text ? extractJSON(bomResult.text) : null;
  if (!bomData || !bomData.bomItems) return res.json({ text: "Could you describe the application in more detail? For example: voltage, current, key requirements.", intent: intent, mode: "question" });
  var bomParts = bomData.bomItems.map(function(p) { return p.partNumber; });
  var bomStock = await prefetchStock(bomParts);
  bomData.stockData = bomStock;
  var bomText = "Here is a **sourcing-ready BOM** for your **" + bomData.projectName + "** — " + bomData.bomItems.length + " critical components:";
  var bomResponse = Object.assign({ text: bomText, intent: intent }, bomData);
  setCache(aiCache, bomCacheKey, bomResponse, AI_TTL);
  return res.json(bomResponse);
}

// =============================================
// PART SEARCH - DigiKey category search ONLY
// NO keywords mixed in - category ID does the work
// =============================================
var componentType = detectComponentType(message);
console.log("Component type:", componentType);

if (!componentType) {
  // Unknown component type - ask AI for engineering help
  var unkResult = await callAI(ENGINEERING_SYSTEM, fullMessages, 1500);
  return res.json({ text: unkResult.text || "I couldn't identify the component type. Could you specify the component type? For example: MOSFET, op-amp, capacitor, inductor, LDO, gate driver, etc.", intent: intent, mode: "text" });
}

// Search DigiKey by category ONLY - no keywords
var dkProducts = await searchByCategory(componentType, requiredSpecs, 60);

if (!dkProducts || dkProducts.length === 0) {
  return res.json({ text: "DigiKey returned no results for " + (DK_CATEGORIES[componentType] && DK_CATEGORIES[componentType].name) + " with these specs. Try relaxing the requirements.", intent: intent, mode: "text" });
}

// Convert all products to our format (includes spec extraction)
var allParts = dkProducts.map(function(p) { return convertProduct(p, componentType); });

// Filter by required specs - this is where 60V parts get rejected when 100V is requested
var filteredParts = filterBySpecs(allParts, requiredSpecs, componentType);
console.log("After spec filter:", filteredParts.length, "of", allParts.length, "parts remain");

// If filtering removed too many, relax and keep top matched
if (filteredParts.length < 3) {
  console.log("Too few after filter, relaxing spec check");
  filteredParts = allParts;
}

// Sort: in-stock first, then closest to requested specs, then by stock quantity
filteredParts = filteredParts.sort(function(a, b) {
  var aIn = a.dkStock > 0 ? 1 : 0;
  var bIn = b.dkStock > 0 ? 1 : 0;
  if (bIn !== aIn) return bIn - aIn;
  var aScore = scoreCloseness(a._specs, requiredSpecs, componentType);
  var bScore = scoreCloseness(b._specs, requiredSpecs, componentType);
  if (Math.abs(aScore - bScore) > 0.05) return aScore - bScore;
  return b.dkStock - a.dkStock;
});

// Take top 4 results
var topParts = filteredParts.slice(0, 4);
console.log("Top parts:", topParts.map(function(p) { return p.partNumber + " (" + p.dkStock + " in stock)"; }).join(", "));

// Get Mouser stock for each part
var stockDataMap = {};
for (var ti = 0; ti < topParts.length; ti++) {
  var mpn = topParts[ti].partNumber;
  var cached = getCached(stockCache, mpn);
  if (cached) { stockDataMap[mpn] = cached; continue; }
  var mouser = await lookupMouser(mpn);
  var total = topParts[ti].dkStock + (mouser ? mouser.stock : 0);
  var bestPrice = topParts[ti].dkPrice;
  var bestPriceSource = "Digi-Key";
  if (mouser && mouser.price) {
    var mv2 = parseFloat((mouser.price || "999").replace(/[^0-9.]/g, "")) || 999;
    var cv2 = parseFloat((bestPrice || "999").replace(/[^0-9.]/g, "")) || 999;
    if (mv2 < cv2) { bestPrice = mouser.price; bestPriceSource = "Mouser"; }
  }
  var sdata2 = { found: total > 0, totalStock: total, bestPrice: bestPrice, bestPriceSource: bestPriceSource, digikey: { found: topParts[ti].dkStock > 0, stock: topParts[ti].dkStock, price: topParts[ti].dkPrice, url: topParts[ti].dkUrl }, mouser: mouser, octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(mpn) };
  setCache(stockCache, mpn, sdata2, STOCK_TTL);
  stockDataMap[mpn] = sdata2;
}

// AI enrichment: rank and explain only - never picks new parts
var enrichPrompt = "User asked: " + message + "\n\nReal DigiKey results (category: " + (DK_CATEGORIES[componentType] && DK_CATEGORIES[componentType].name) + "):\n" +
  topParts.map(function(p, idx) {
    return (idx + 1) + ". " + p.partNumber + " (" + p.manufacturer + ") | DK Stock: " + p.dkStock + " | Specs: " + p.keySpecs.map(function(s) { return s.label + "=" + s.value + s.unit; }).join(", ");
  }).join("\n");

var enrichResult = await callAI(ENRICHMENT_SYSTEM, [{ role: "user", content: enrichPrompt }], 1500);
var category = (DK_CATEGORIES[componentType] && DK_CATEGORIES[componentType].name) || componentType;
var interpretation = "Real-time DigiKey results for " + message.substring(0, 50);
var designTip = "";

if (enrichResult.text) {
  var enrichData = extractJSON(enrichResult.text);
  if (enrichData) {
    if (enrichData.category) category = enrichData.category;
    if (enrichData.interpretation) interpretation = enrichData.interpretation;
    if (enrichData.designTip) designTip = enrichData.designTip;
    if (enrichData.rankedResults) {
      enrichData.rankedResults.forEach(function(r) {
        topParts.forEach(function(p) {
          if (p.partNumber === r.partNumber) { p.rank = r.rank || "alternative"; p.aeComment = r.aeComment || ""; p.caution = r.caution || null; p.applications = r.applications || []; }
        });
      });
    }
  }
}

// Remove internal _specs before sending to frontend
topParts.forEach(function(p) { delete p._specs; });

return res.json({
  text: "Found **" + topParts.length + " real parts** from DigiKey — " + interpretation + ". Best match first:",
  mode: "search",
  category: category,
  interpretation: interpretation,
  results: topParts,
  stockData: stockDataMap,
  designTip: designTip,
  intent: intent,
  source: "DigiKey catalog",
});
```

} catch (err) {
console.error(“Chat error:”, err.message, err.stack);
res.status(500).json({ error: “Server error: “ + err.message });
}
});

// =============================================
// EXCEL BOM UPLOAD
// =============================================
app.post(”/api/excel-bom”, express.raw({ type: “*/*”, limit: “10mb” }), async function(req, res) {
try {
var fileContent = req.body.toString(“utf8”);
var lines = fileContent.split(”\n”).filter(function(l) { return l.trim(); });
if (lines.length === 0) return res.status(400).json({ error: “Empty file” });
var headers = lines[0].split(”,”).map(function(h) { return h.replace(/”/g, “”).trim().toLowerCase(); });
var pnColIdx = 0;
var pnKeywords = [“part number”,“pn”,“mpn”,“part no”,“partno”,“part#”,“component”,“part_number”];
for (var ki = 0; ki < pnKeywords.length; ki++) { for (var hi = 0; hi < headers.length; hi++) { if (headers[hi].indexOf(pnKeywords[ki]) !== -1) { pnColIdx = hi; break; } } }
var partNumbers = [];
for (var li = 1; li < lines.length; li++) {
var cols = lines[li].split(”,”).map(function(c) { return c.replace(/”/g, “”).trim(); });
if (cols[pnColIdx]) partNumbers.push(cols[pnColIdx]);
}
if (partNumbers.length === 0) return res.status(400).json({ error: “No part numbers found.” });
var results = [];
var limit = Math.min(partNumbers.length, 15);
for (var pi = 0; pi < limit; pi++) {
var pn = partNumbers[pi];
if (!pn) continue;
var dkResult = await lookupDigikey(pn);
var mouserResult = await lookupMouser(pn);
var total = (dkResult ? dkResult.stock : 0) + (mouserResult ? mouserResult.stock : 0);
var row = { partNumber: pn, description: “”, category: “”, keySpecs: “”, stock: total, bestPrice: (dkResult && dkResult.price) || (mouserResult && mouserResult.price) || “”, dkStock: dkResult ? dkResult.stock : 0, mousStock: mouserResult ? mouserResult.stock : 0, alt1: “”, alt2: “”, alt3: “” };
try {
var partInfo = await fetchPartSpecs(pn);
if (partInfo) {
row.description = partInfo.description;
row.category = partInfo.categoryName;
row.keySpecs = partInfo.specsText.substring(0, 100);
if (!partInfo.isPassive) {
var compType = detectComponentType(partInfo.description + “ “ + partInfo.categoryName);
if (compType) {
var altProds = await searchByCategory(compType, partInfo.specs, 20);
if (altProds && altProds.length > 0) {
var altConv = altProds.map(function(p) { return convertProduct(p, compType); }).filter(function(p) { return p.partNumber.toUpperCase() !== pn.toUpperCase() && p.dkStock > 0; });
altConv = filterBySpecs(altConv, partInfo.specs, compType);
altConv = altConv.sort(function(a, b) { return scoreCloseness(a._specs, partInfo.specs, compType) - scoreCloseness(b._specs, partInfo.specs, compType); }).slice(0, 3);
if (altConv[0]) row.alt1 = altConv[0].partNumber + “ (” + altConv[0].manufacturer + “)”;
if (altConv[1]) row.alt2 = altConv[1].partNumber + “ (” + altConv[1].manufacturer + “)”;
if (altConv[2]) row.alt3 = altConv[2].partNumber + “ (” + altConv[2].manufacturer + “)”;
}
}
}
}
} catch (e) { console.error(“Excel alt lookup failed for “ + pn, e.message); }
results.push(row);
}
var csvHeaders = [“Part Number”,“Description”,“Category”,“Key Specs”,“Total Stock”,“Best Price”,“Digi-Key Stock”,“Mouser Stock”,“Alternative 1”,“Alternative 2”,“Alternative 3”];
var csvRows = results.map(function(r) { return [r.partNumber, r.description, r.category, r.keySpecs, r.stock, r.bestPrice, r.dkStock, r.mousStock, r.alt1, r.alt2, r.alt3]; });
var csv = [csvHeaders].concat(csvRows).map(function(row) { return row.map(function(c) { return ‘”’ + String(c || “”).replace(/”/g, ‘””’) + ‘”’; }).join(”,”); }).join(”\n”);
res.setHeader(“Content-Type”, “text/csv”);
res.setHeader(“Content-Disposition”, “attachment; filename=BOM_PartTensor.csv”);
res.send(csv);
} catch (err) {
console.error(“Excel BOM error:”, err.message);
res.status(500).json({ error: “Failed to process file: “ + err.message });
}
});

// =============================================
// START
// =============================================
var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
console.log(”\nPartTensor backend running on port “ + PORT);
console.log(”  GET  /api/health”);
console.log(”  POST /api/chat  — DigiKey category search + AI enrichment”);
console.log(”  POST /api/excel-bom\n”);
});
