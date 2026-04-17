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
// DIGIKEY CATEGORY + PARAMETER IDs
// These are real DigiKey API IDs
// =============================================
var DK_CATEGORIES = {
  // Discrete Semiconductors
  "mosfet_n":       { id: 278,  name: "MOSFETs - Single N-Channel" },
  "mosfet_p":       { id: 277,  name: "MOSFETs - Single P-Channel" },
  "mosfet_dual":    { id: 279,  name: "MOSFETs - Dual N & P-Channel" },
  "bjt_npn":        { id: 281,  name: "Transistors - Bipolar (BJT) - Single NPN" },
  "bjt_pnp":        { id: 282,  name: "Transistors - Bipolar (BJT) - Single PNP" },
  "diode_rectifier":{ id: 286,  name: "Diodes - Rectifiers - Single" },
  "diode_schottky": { id: 287,  name: "Diodes - Rectifiers - Schottky" },
  "diode_zener":    { id: 291,  name: "Zener Diodes" },
  "igbt":           { id: 280,  name: "IGBTs - Single" },
  // ICs
  "opamp":          { id: 696,  name: "Linear - Amplifiers - Instrumentation, OP Amps, Buffer Amps" },
  "ldo":            { id: 701,  name: "Linear - Voltage Regulators - Linear (LDO)" },
  "dcdc_converter": { id: 706,  name: "PMIC - Voltage Regulators - DC DC Switching Regulators" },
  "gate_driver":    { id: 712,  name: "Gate Drivers" },
  "comparator":     { id: 697,  name: "Linear - Comparators" },
  "voltage_ref":    { id: 702,  name: "Voltage References" },
  // Passives
  "capacitor_ceramic":{ id: 399, name: "Ceramic Capacitors" },
  "capacitor_electrolytic":{ id: 406, name: "Aluminum Electrolytic Capacitors" },
  "capacitor_tantalum":{ id: 408, name: "Tantalum Capacitors" },
  "capacitor_film": { id: 404,  name: "Film Capacitors" },
  "inductor_power": { id: 389,  name: "Fixed Inductors" },
  "inductor_shielded":{ id: 391, name: "Power Inductors - SMD" },
  "resistor_smd":   { id: 411,  name: "Chip Resistor - Surface Mount" },
  "resistor_thru":  { id: 412,  name: "Through Hole Resistors" },
  // Sensors
  "current_sensor": { id: 730,  name: "Current Sensors" },
  "temp_sensor":    { id: 727,  name: "Temperature Sensors - Analog and Digital Output" },
};

// DigiKey Parameter IDs for filtering
// These are real parameter IDs used in DigiKey's filter system
var DK_PARAMS = {
  // Universal
  "in_stock":       1,      // In Stock filter
  // MOSFET parameters
  "vds_max":        96,     // Drain-Source Voltage (Vdss)
  "id_cont":        97,     // Current - Continuous Drain (Id) @ 25C
  "rds_on_max":     98,     // Rds On (Max) @ Id, Vgs
  "vgs_th":         99,     // Vgs(th) (Max)
  "qg":             1374,   // Gate Charge (Qg) (Max) @ Vgs
  "pd_max":         100,    // Power Dissipation (Max)
  "package":        16,     // Package / Case
  // Op-amp parameters
  "gbw":            741,    // Gain Bandwidth Product
  "slew_rate":      742,    // Slew Rate
  "vcc_min":        743,    // Voltage - Supply, Single (V+) (Min)
  "vcc_max":        744,    // Voltage - Supply, Single (V+) (Max)
  "input_offset":   745,    // Voltage - Input Offset
  "noise":          746,    // Current - Input Bias
  // LDO parameters
  "vout_fixed":     1015,   // Voltage - Output (Fixed)
  "iout_max":       1016,   // Current - Output
  "vin_max":        1017,   // Voltage - Input (Max)
  "dropout":        1018,   // Voltage - Dropout (Typical)
  // Capacitor parameters
  "capacitance":    2049,   // Capacitance
  "cap_voltage":    2050,   // Voltage Rated
  "tolerance":      2051,   // Tolerance
  "temp_coeff":     2052,   // Temperature Coefficient
  // Inductor parameters
  "inductance":     2087,   // Inductance
  "ind_current":    2088,   // Current Rating (Amps)
  "ind_resistance": 2089,   // DC Resistance (DCR)
  "ind_freq":       2090,   // Frequency - Self Resonant
  // Resistor parameters
  "resistance":     2096,   // Resistance
  "res_power":      2097,   // Power (Watts)
  "res_tolerance":  2098,   // Tolerance
  // Diode parameters
  "vrrm":           103,    // Voltage - Peak Reverse (Vrrm)
  "if_avg":         104,    // Current - Average Rectified (Io)
  "vf":             105,    // Voltage - Forward (Vf) (Max) @ If
};

// =============================================
// COMPONENT TYPE DETECTOR
// Maps query keywords to DigiKey categories
// Returns the best matching category key
// =============================================
function detectComponentType(query) {
  var lower = query.toLowerCase();

  // MOSFET detection
  if (lower.includes("mosfet") || lower.includes("fet")) {
    if (lower.includes("p-channel") || lower.includes("p channel") || lower.includes("pmos")) return "mosfet_p";
    return "mosfet_n"; // default N-channel
  }

  // IGBT
  if (lower.includes("igbt")) return "igbt";

  // BJT
  if (lower.includes("bjt") || lower.includes("transistor") || lower.includes("npn")) return "bjt_npn";
  if (lower.includes("pnp")) return "bjt_pnp";

  // Diodes
  if (lower.includes("schottky")) return "diode_schottky";
  if (lower.includes("zener")) return "diode_zener";
  if (lower.includes("diode") || lower.includes("rectifier")) return "diode_rectifier";

  // Op-amps
  if (lower.includes("op-amp") || lower.includes("opamp") || lower.includes("op amp") || lower.includes("operational amplifier") || lower.includes("amplifier")) return "opamp";

  // Comparator
  if (lower.includes("comparator")) return "comparator";

  // Voltage reference
  if (lower.includes("voltage reference") || lower.includes("vref")) return "voltage_ref";

  // LDO / Linear regulator
  if (lower.includes("ldo") || lower.includes("linear regulator") || lower.includes("voltage regulator")) return "ldo";

  // DC-DC converter
  if (lower.includes("dc-dc") || lower.includes("dcdc") || lower.includes("buck") || lower.includes("boost") || lower.includes("switching regulator")) return "dcdc_converter";

  // Gate driver
  if (lower.includes("gate driver") || lower.includes("gate drive")) return "gate_driver";

  // Capacitors
  if (lower.includes("capacitor") || lower.includes(" cap ") || lower.includes("uf") || lower.includes("nf") || lower.includes("pf")) {
    if (lower.includes("electrolytic") || lower.includes("aluminum") || lower.includes("aluminium")) return "capacitor_electrolytic";
    if (lower.includes("tantalum")) return "capacitor_tantalum";
    if (lower.includes("film")) return "capacitor_film";
    return "capacitor_ceramic"; // default
  }

  // Inductors
  if (lower.includes("inductor") || lower.includes("inductance") || lower.includes(" uh") || lower.includes(" nh") || lower.includes(" mh")) {
    return "inductor_power";
  }

  // Resistors
  if (lower.includes("resistor") || lower.includes("resistance") || lower.includes(" ohm") || lower.includes(" kohm")) {
    return "resistor_smd";
  }

  // Current sensor
  if (lower.includes("current sensor") || lower.includes("current sense") || lower.includes("acs")) return "current_sensor";

  // Temperature sensor
  if (lower.includes("temperature sensor") || lower.includes("temp sensor") || lower.includes("thermistor")) return "temp_sensor";

  return null; // unknown — fall back to keyword search
}

// =============================================
// BUILD DIGIKEY PARAMETRIC SEARCH FILTERS
// Maps required specs to DigiKey filter format
// =============================================
function buildDigikeyFilters(componentType, requiredSpecs) {
  var filters = [];

  if (componentType === "mosfet_n" || componentType === "mosfet_p" || componentType === "igbt") {
    if (requiredSpecs.voltage) {
      // Vds >= requested voltage, prefer closest match
      // DigiKey filter: minimum value
      filters.push({ parameterId: DK_PARAMS.vds_max, filterValues: [String(Math.ceil(requiredSpecs.voltage))] });
    }
    if (requiredSpecs.current) {
      filters.push({ parameterId: DK_PARAMS.id_cont, filterValues: [String(Math.ceil(requiredSpecs.current))] });
    }
  }

  if (componentType === "opamp") {
    if (requiredSpecs.gbwMHz) {
      filters.push({ parameterId: DK_PARAMS.gbw, filterValues: [String(requiredSpecs.gbwMHz)] });
    }
  }

  if (componentType === "ldo") {
    if (requiredSpecs.outputV) {
      filters.push({ parameterId: DK_PARAMS.vout_fixed, filterValues: [String(requiredSpecs.outputV)] });
    }
    if (requiredSpecs.current || requiredSpecs.currentMA) {
      var iout = requiredSpecs.current || (requiredSpecs.currentMA / 1000);
      filters.push({ parameterId: DK_PARAMS.iout_max, filterValues: [String(iout)] });
    }
  }

  if (componentType === "capacitor_ceramic" || componentType === "capacitor_electrolytic" || componentType === "capacitor_tantalum" || componentType === "capacitor_film") {
    if (requiredSpecs.voltage) {
      filters.push({ parameterId: DK_PARAMS.cap_voltage, filterValues: [String(Math.ceil(requiredSpecs.voltage))] });
    }
  }

  if (componentType === "inductor_power" || componentType === "inductor_shielded") {
    if (requiredSpecs.current) {
      filters.push({ parameterId: DK_PARAMS.ind_current, filterValues: [String(requiredSpecs.current)] });
    }
  }

  if (componentType === "diode_rectifier" || componentType === "diode_schottky") {
    if (requiredSpecs.voltage) {
      filters.push({ parameterId: DK_PARAMS.vrrm, filterValues: [String(Math.ceil(requiredSpecs.voltage))] });
    }
    if (requiredSpecs.current) {
      filters.push({ parameterId: DK_PARAMS.if_avg, filterValues: [String(requiredSpecs.current)] });
    }
  }

  return filters;
}

// =============================================
// DIGIKEY PARAMETRIC SEARCH
// This is the core function - gets REAL parts from DigiKey
// based on component type and specs
// =============================================
async function searchDigikeyParametric(componentType, requiredSpecs, keyword) {
  try {
    var fetch = (await import("node-fetch")).default;
    var token = await getDigikeyToken();
    if (!token) return null;

    var category = DK_CATEGORIES[componentType];
    var filters = buildDigikeyFilters(componentType, requiredSpecs);

    console.log("DigiKey parametric search: category=" + (category ? category.name : "keyword") + " filters=" + filters.length);

    var searchBody = {
      Keywords: "",
      Limit: 20,
      Offset: 0,
      FilterOptionsRequest: {
        InStock: true,
      },
      SortOptions: {
        Field: "QuantityAvailable",
        SortOrder: "Descending",
      },
    };

    // Add category filter if we know the component type
    if (category) {
      searchBody.CategoryFilter = { CategoryId: category.id };
    }

    // Add parametric filters
    if (filters.length > 0) {
      searchBody.FilterOptionsRequest.ParametricFilters = filters;
    }

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
      body: JSON.stringify(searchBody),
    });

    if (!res.ok) {
      var errText = await res.text();
      console.error("DigiKey parametric search failed:", res.status, errText.substring(0, 200));
      return null;
    }

    var data = await res.json();
    var products = data.Products || [];
    console.log("DigiKey returned", products.length, "products");
    return products;

  } catch (e) {
    console.error("DigiKey parametric search error:", e.message);
    return null;
  }
}

// =============================================
// CONVERT DIGIKEY PRODUCT TO OUR PART FORMAT
// Extracts specs from DigiKey product parameters
// =============================================
function convertDKProduct(product, componentType) {
  var parameters = product.Parameters || [];
  var keySpecs = [];
  var specMap = {};

  // Extract all parameters into a map
  for (var i = 0; i < parameters.length; i++) {
    var param = parameters[i];
    var pname = (param.Parameter || "").toLowerCase();
    var pval = param.Value || "";
    specMap[pname] = pval;
  }

  // Build keySpecs based on component type
  if (componentType === "mosfet_n" || componentType === "mosfet_p" || componentType === "igbt") {
    var vds = specMap["voltage - drain to source (vdss)"] || specMap["vdss"] || specMap["voltage - collector emitter breakdown (max)"] || "";
    var id = specMap["current - continuous drain (id) @ 25°c"] || specMap["id"] || specMap["current - collector (ic) (max)"] || "";
    var rds = specMap["rds on (max) @ id, vgs"] || specMap["rds(on)"] || specMap["collector emitter saturation voltage (vce(sat)) (max) @ ib, ic"] || "";
    var qg = specMap["gate charge (qg) (max) @ vgs"] || specMap["qg"] || "";
    var pkg = product.PackageType || specMap["package / case"] || "";
    if (vds) keySpecs.push({ label: "VDS", value: vds.replace(/[^0-9.]/g, ""), unit: "V" });
    if (id) keySpecs.push({ label: "ID", value: id.replace(/[^0-9.]/g, ""), unit: "A" });
    if (rds) keySpecs.push({ label: "RDS(on)", value: rds.replace(/[^0-9.]/g, ""), unit: "mΩ" });
    if (qg) keySpecs.push({ label: "Qg", value: qg.replace(/[^0-9.]/g, ""), unit: "nC" });
    if (pkg) keySpecs.push({ label: "Package", value: pkg, unit: "" });
  } else if (componentType === "opamp") {
    var gbw = specMap["gain bandwidth product"] || specMap["gbp"] || specMap["-3db bandwidth"] || "";
    var sr = specMap["slew rate"] || "";
    var vsupply = specMap["voltage - supply, single (v+) (min)"] || "";
    var vsupplymax = specMap["voltage - supply, single (v+) (max)"] || "";
    var noise = specMap["voltage - input offset"] || "";
    var pkg2 = product.PackageType || "";
    if (gbw) keySpecs.push({ label: "GBW", value: gbw.replace(/[^0-9.]/g, ""), unit: "MHz" });
    if (sr) keySpecs.push({ label: "Slew Rate", value: sr.replace(/[^0-9.]/g, ""), unit: "V/us" });
    if (vsupplymax) keySpecs.push({ label: "Vcc Max", value: vsupplymax.replace(/[^0-9.]/g, ""), unit: "V" });
    if (noise) keySpecs.push({ label: "Vos", value: noise.replace(/[^0-9.]/g, ""), unit: "mV" });
    if (pkg2) keySpecs.push({ label: "Package", value: pkg2, unit: "" });
  } else if (componentType === "ldo") {
    var vout = specMap["voltage - output (fixed)"] || specMap["voltage - output (min/fixed)"] || "";
    var iout = specMap["current - output"] || "";
    var vin = specMap["voltage - input (max)"] || "";
    var dropout = specMap["voltage - dropout (typical)"] || "";
    var pkg3 = product.PackageType || "";
    if (vout) keySpecs.push({ label: "Vout", value: vout.replace(/[^0-9.]/g, ""), unit: "V" });
    if (iout) keySpecs.push({ label: "Iout", value: iout.replace(/[^0-9.]/g, ""), unit: "A" });
    if (vin) keySpecs.push({ label: "Vin Max", value: vin.replace(/[^0-9.]/g, ""), unit: "V" });
    if (dropout) keySpecs.push({ label: "Dropout", value: dropout.replace(/[^0-9.]/g, ""), unit: "mV" });
    if (pkg3) keySpecs.push({ label: "Package", value: pkg3, unit: "" });
  } else if (componentType && componentType.startsWith("capacitor")) {
    var cap = specMap["capacitance"] || "";
    var capv = specMap["voltage rated"] || "";
    var captol = specMap["tolerance"] || "";
    var captc = specMap["temperature coefficient"] || "";
    var capkg = product.PackageType || "";
    if (cap) keySpecs.push({ label: "Capacitance", value: cap.replace(/[^0-9.]/g, ""), unit: "uF" });
    if (capv) keySpecs.push({ label: "Voltage", value: capv.replace(/[^0-9.]/g, ""), unit: "V" });
    if (captol) keySpecs.push({ label: "Tolerance", value: captol, unit: "" });
    if (captc) keySpecs.push({ label: "Temp Coeff", value: captc, unit: "" });
    if (capkg) keySpecs.push({ label: "Package", value: capkg, unit: "" });
  } else if (componentType && componentType.startsWith("inductor")) {
    var ind = specMap["inductance"] || "";
    var indcurr = specMap["current rating (amps)"] || specMap["current - saturation (isat)"] || "";
    var inddcr = specMap["dc resistance (dcr)"] || "";
    var indpkg = product.PackageType || "";
    if (ind) keySpecs.push({ label: "Inductance", value: ind.replace(/[^0-9.]/g, ""), unit: "uH" });
    if (indcurr) keySpecs.push({ label: "Irated", value: indcurr.replace(/[^0-9.]/g, ""), unit: "A" });
    if (inddcr) keySpecs.push({ label: "DCR", value: inddcr.replace(/[^0-9.]/g, ""), unit: "mΩ" });
    if (indpkg) keySpecs.push({ label: "Package", value: indpkg, unit: "" });
  } else if (componentType && componentType.startsWith("diode")) {
    var diodevrr = specMap["voltage - peak reverse (vrrm)"] || "";
    var diodevf = specMap["voltage - forward (vf) (max) @ if"] || "";
    var diodeif = specMap["current - average rectified (io)"] || "";
    var diodepkg = product.PackageType || "";
    if (diodevrr) keySpecs.push({ label: "Vrrm", value: diodevrr.replace(/[^0-9.]/g, ""), unit: "V" });
    if (diodeif) keySpecs.push({ label: "Io", value: diodeif.replace(/[^0-9.]/g, ""), unit: "A" });
    if (diodevf) keySpecs.push({ label: "Vf", value: diodevf.replace(/[^0-9.]/g, ""), unit: "V" });
    if (diodepkg) keySpecs.push({ label: "Package", value: diodepkg, unit: "" });
  } else {
    // Generic — just take first 4 parameters
    var count = 0;
    for (var pi = 0; pi < parameters.length && count < 4; pi++) {
      var pv = parseFloat(parameters[pi].Value || "");
      if (!isNaN(pv)) {
        keySpecs.push({ label: parameters[pi].Parameter || "", value: String(pv), unit: "" });
        count++;
      }
    }
    var gpkg = product.PackageType || "";
    if (gpkg) keySpecs.push({ label: "Package", value: gpkg, unit: "" });
  }

  var unitPrice = product.UnitPrice || (product.StandardPricing && product.StandardPricing[0] && product.StandardPricing[0].UnitPrice) || null;
  var stock = product.QuantityAvailable || 0;
  var description = (product.Description && product.Description.ProductDescription) || "";

  return {
    partNumber: product.ManufacturerProductNumber || "",
    manufacturer: (product.Manufacturer && product.Manufacturer.Name) || "",
    type: (DK_CATEGORIES[componentType] && DK_CATEGORIES[componentType].name) || description.split(" ").slice(0, 4).join(" "),
    description: description,
    package: product.PackageType || "",
    keySpecs: keySpecs,
    stock: stock,
    price: unitPrice ? "$" + parseFloat(unitPrice).toFixed(3) : null,
    url: product.ProductUrl || "",
    category: componentType,
    applications: [],
    rank: "alternative",
    aeComment: "",
    caution: null,
  };
}

// =============================================
// SCORE PART CLOSENESS TO REQUESTED SPECS
// Lower score = better match
// =============================================
function scorePartCloseness(part, requiredSpecs, componentType) {
  var score = 0;
  var specs = part.keySpecs || [];

  function getVal(label) {
    for (var i = 0; i < specs.length; i++) {
      if ((specs[i].label || "").toLowerCase().indexOf(label) !== -1) {
        var v = parseFloat(specs[i].value);
        return isNaN(v) ? null : v;
      }
    }
    return null;
  }

  // For min specs: penalty = how much over the requirement (closer to req = better)
  // For exact specs: penalty = % deviation from required value

  if (componentType === "mosfet_n" || componentType === "mosfet_p" || componentType === "igbt") {
    if (requiredSpecs.voltage) {
      var vds = getVal("vds") || getVal("voltage");
      if (vds) score += Math.max(0, (vds - requiredSpecs.voltage) / requiredSpecs.voltage);
    }
    if (requiredSpecs.current) {
      var id = getVal("id") || getVal("current");
      if (id) score += Math.max(0, (id - requiredSpecs.current) / requiredSpecs.current);
    }
  } else if (componentType === "opamp") {
    if (requiredSpecs.gbwMHz) {
      var gbw = getVal("gbw") || getVal("bandwidth");
      if (gbw) score += Math.max(0, (gbw - requiredSpecs.gbwMHz) / requiredSpecs.gbwMHz);
    }
  } else if (componentType === "ldo") {
    if (requiredSpecs.outputV) {
      var vout = getVal("vout") || getVal("output");
      if (vout) score += Math.abs(vout - requiredSpecs.outputV) / requiredSpecs.outputV;
    }
  } else if (componentType && componentType.startsWith("capacitor")) {
    if (requiredSpecs.capacitanceUF) {
      var cap = getVal("capacitance");
      if (cap) score += Math.abs(cap - requiredSpecs.capacitanceUF) / requiredSpecs.capacitanceUF;
    }
  } else if (componentType && componentType.startsWith("inductor")) {
    if (requiredSpecs.inductanceUH) {
      var ind = getVal("inductance");
      if (ind) score += Math.abs(ind - requiredSpecs.inductanceUH) / requiredSpecs.inductanceUH;
    }
  }

  return score;
}

// =============================================
// DIGIKEY SINGLE PART LOOKUP
// =============================================
async function lookupDigikey(mpn) {
  try {
    var fetch = (await import("node-fetch")).default;
    var token = await getDigikeyToken();
    if (!token) return null;
    var res = await fetch(
      "https://api.digikey.com/products/v4/search/" + encodeURIComponent(mpn) + "/productdetails",
      { method: "GET", headers: { "Authorization": "Bearer " + token, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD" } }
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
// PREFETCH STOCK FOR MOUSER (DK already fetched)
// =============================================
async function enrichWithMouserStock(parts) {
  for (var i = 0; i < parts.length; i++) {
    var pn = parts[i].partNumber;
    var cached = getCached(stockCache, pn);
    if (cached) { parts[i].stockData = cached; continue; }
    var mouser = await lookupMouser(pn);
    var dkStock = parts[i].stock || 0;
    var mousStock = mouser ? mouser.stock : 0;
    var total = dkStock + mousStock;
    var bestPrice = parts[i].price;
    var bestPriceSource = "Digi-Key";
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
      digikey: { found: dkStock > 0, stock: dkStock, price: parts[i].price, url: parts[i].url },
      mouser: mouser,
      octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(pn),
    };
    setCache(stockCache, pn, sr, STOCK_TTL);
    parts[i].stockData = sr;
  }
  return parts;
}

// =============================================
// EXTRACT REQUIRED SPECS FROM QUERY
// =============================================
function extractRequiredSpecs(query) {
  var lower = query.toLowerCase();
  var specs = {};

  var vMatches = lower.match(/(\d+(?:\.\d+)?)\s*v\b/gi) || [];
  if (vMatches.length > 0) {
    var volts = vMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; });
    if (volts.length > 0) specs.voltage = Math.max.apply(null, volts);
  }
  var aMatches = lower.match(/(\d+(?:\.\d+)?)\s*a\b/gi) || [];
  if (aMatches.length > 0) {
    var amps = aMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0; });
    if (amps.length > 0) specs.current = Math.max.apply(null, amps);
  }
  var maMatches = lower.match(/(\d+(?:\.\d+)?)\s*ma\b/gi) || [];
  if (maMatches.length > 0 && !specs.current) {
    var mamps = maMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v); });
    if (mamps.length > 0) specs.currentMA = Math.max.apply(null, mamps);
  }
  var wMatches = lower.match(/(\d+(?:\.\d+)?)\s*w\b/gi) || [];
  if (wMatches.length > 0) {
    var watts = wMatches.map(function(m) { return parseFloat(m); }).filter(function(v) { return !isNaN(v) && v > 0.1; });
    if (watts.length > 0) specs.power = Math.max.apply(null, watts);
  }
  var ufMatches = lower.match(/(\d+(?:\.\d+)?)\s*uf\b/gi) || [];
  if (ufMatches.length > 0) specs.capacitanceUF = parseFloat(ufMatches[0]);
  var nfMatches = lower.match(/(\d+(?:\.\d+)?)\s*nf\b/gi) || [];
  if (nfMatches.length > 0 && !specs.capacitanceUF) specs.capacitanceNF = parseFloat(nfMatches[0]);
  var pfMatches = lower.match(/(\d+(?:\.\d+)?)\s*pf\b/gi) || [];
  if (pfMatches.length > 0 && !specs.capacitanceUF && !specs.capacitanceNF) specs.capacitancePF = parseFloat(pfMatches[0]);
  var uhMatches = lower.match(/(\d+(?:\.\d+)?)\s*uh\b/gi) || [];
  if (uhMatches.length > 0) specs.inductanceUH = parseFloat(uhMatches[0]);
  var nhMatches = lower.match(/(\d+(?:\.\d+)?)\s*nh\b/gi) || [];
  if (nhMatches.length > 0 && !specs.inductanceUH) specs.inductanceNH = parseFloat(nhMatches[0]);
  var mhzMatches = lower.match(/(\d+(?:\.\d+)?)\s*mhz\b/gi) || [];
  if (mhzMatches.length > 0) {
    if (lower.includes("gbw") || lower.includes("gain bandwidth") || lower.includes("bandwidth")) specs.gbwMHz = parseFloat(mhzMatches[0]);
    else specs.freqMHz = parseFloat(mhzMatches[0]);
  }
  var nvMatches = lower.match(/(\d+(?:\.\d+)?)\s*nv\b/gi) || [];
  if (nvMatches.length > 0) specs.noiseNV = parseFloat(nvMatches[0]);
  var mvMatches = lower.match(/(\d+(?:\.\d+)?)\s*mv\b/gi) || [];
  if (mvMatches.length > 0 && (lower.includes("dropout") || lower.includes("ldo"))) specs.dropoutMV = parseFloat(mvMatches[0]);

  // Output voltage detection for LDOs
  var voutMatch = lower.match(/(\d+(?:\.\d+)?)\s*v\s*(?:output|ldo|regulator)/i) || lower.match(/(?:output|ldo|regulator)\s*(\d+(?:\.\d+)?)\s*v/i) || [];
  if (voutMatch && voutMatch[1]) specs.outputV = parseFloat(voutMatch[1]);

  console.log("Required specs:", JSON.stringify(specs));
  return specs;
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
// AI ENRICHMENT PROMPT
// AI only ranks and explains — does NOT pick parts
// =============================================
var ENRICHMENT_SYSTEM = "You are a senior application engineer. You are given a list of real electronic parts from DigiKey. Your job is to:\n1. Rank them from best to worst fit for the user's request\n2. Set rank: first part = 'top', second = 'good', rest = 'alternative'\n3. Write a brief aeComment for each part explaining why it is or is not ideal\n4. Add a caution note if relevant (e.g. availability concerns, design considerations)\n5. Add a designTip for the overall selection\n6. Add relevant applications array\n\nDo NOT change any part numbers or specs. Only add rank, aeComment, caution, applications, designTip.\n\nRespond ONLY with raw JSON starting with {:\n{\"rankedResults\":[{\"partNumber\":\"IRF540NPBF\",\"rank\":\"top\",\"aeComment\":\"reason\",\"caution\":null,\"applications\":[\"Motor Drive\"]}],\"designTip\":\"tip\",\"category\":\"N-Channel MOSFET\",\"interpretation\":\"one sentence\"}";

var INTENT_SYSTEM = "You classify hardware engineering queries. Consider the full conversation context. If the new message is a follow-up refinement (like 'only in stock', 'cheaper', 'different package', 'find alternatives'), classify it as the SAME intent as the previous turn.\n\nCRITICAL: Any message asking for a component, part, chip, MOSFET, op-amp, capacitor, inductor, resistor, diode, regulator, sensor, IC, or any electronic part MUST be classified as part_search.\n\nRespond ONLY with JSON:\n{\"intent\":\"part_search|find_alternatives|generate_bom|circuit_question|calculation|correction|general\",\"partNumber\":\"extracted part number or null\",\"needsMoreInfo\":false,\"followUpQuestion\":null}";

var ENGINEERING_SYSTEM = "You are PartTensor, a senior hardware application engineer AI. Help engineers with component selection, circuit design, calculations, and troubleshooting. Be direct, technical and precise. Use real formulas and examples. Format with **bold headers** and - bullet points.";

var BOM_SYSTEM = "You are a senior hardware application engineer. Generate a smart Bill of Materials. Only critical components: MOSFETs, ICs, drivers, specialized inductors, electrolytic caps, current sense resistors, crystals, connectors, optocouplers, diodes, sensors. NO generic resistors, 100nF caps, generic LEDs. Full Digi-Key part numbers. 5 keySpecs per part.\nRespond ONLY with raw JSON starting with {:\n{\"bomItems\":[{\"id\":1,\"function\":\"Gate Driver\",\"partNumber\":\"IR2184SPBF\",\"manufacturer\":\"Infineon\",\"description\":\"one line\",\"category\":\"IC\",\"quantity\":1,\"keySpecs\":\"600V 2A SO-8\",\"package\":\"SO-8\",\"priority\":\"critical\",\"unitPrice\":\"$1.20\",\"notes\":null}],\"projectName\":\"name\",\"description\":\"sentence\",\"voltage\":\"V\",\"power\":\"W\",\"designNotes\":\"notes\",\"totalEstimate\":\"$15-25\"}";

var PASSIVE_KEYWORDS = ["connector","receptacle","plug","socket","jack","header","terminal","coax","mmcx","sma","bnc","usb ","hdmi","resistor","capacitor","inductor","ferrite","crystal","resonator","transformer","relay","switch","fuse","varistor","thermistor","potentiometer","antenna","filter","balun"];
function isPassiveConnector(description, categoryName) {
  var text = ((description || "") + " " + (categoryName || "")).toLowerCase();
  for (var i = 0; i < PASSIVE_KEYWORDS.length; i++) { if (text.indexOf(PASSIVE_KEYWORDS[i]) !== -1) return true; }
  return false;
}

async function fetchPartSpecs(mpn) {
  try {
    var fetch = (await import("node-fetch")).default;
    var token = await getDigikeyToken();
    if (!token) return null;
    var res = await fetch("https://api.digikey.com/products/v4/search/" + encodeURIComponent(mpn) + "/productdetails", { method: "GET", headers: { "Authorization": "Bearer " + token, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD" } });
    var product = null;
    if (res.ok) { var data = await res.json(); product = data.Product || data; }
    else {
      var res2 = await fetch("https://api.digikey.com/products/v4/search/keyword", { method: "POST", headers: { "Authorization": "Bearer " + token, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD", "Content-Type": "application/json" }, body: JSON.stringify({ Keywords: mpn, Limit: 3, Offset: 0 }) });
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
    return { mpn: product.ManufacturerProductNumber || mpn, manufacturer: (product.Manufacturer && product.Manufacturer.Name) || "", description: description, categoryName: categoryName, isPassive: isPassiveConnector(description, categoryName), specs: specs, specsText: specLines.slice(0, 15).join("; "), dkSearchUrl: "https://www.digikey.com/en/products/result?keywords=" + encodeURIComponent(searchKeyword) + "&stock=1", mouserSearchUrl: "https://www.mouser.com/Search/Refine?Keyword=" + encodeURIComponent(mpn) + "&inStock=1", octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(mpn) + "&in_stock=1" };
  } catch (e) { console.error("fetchPartSpecs failed:", e.message); return null; }
}

function buildAltSystem(originalPart) {
  var specs = originalPart.specs || {};
  var specLines = [];
  if (specs.voltage) specLines.push("Voltage >= " + specs.voltage + "V");
  if (specs.current) specLines.push("Current >= " + specs.current + "A");
  if (specs.resistance) specLines.push("Rds/Ron <= " + specs.resistance);
  if (specs.power) specLines.push("Power >= " + specs.power + "W");
  if (specLines.length === 0) specLines.push("Match: " + originalPart.specsText.substring(0, 150));
  return "Find EXACTLY 4 alternatives from 4 DIFFERENT manufacturers for: " + originalPart.mpn + " by " + originalPart.manufacturer + " — " + originalPart.description + "\nREQUIRED SPECS (real DigiKey data): " + specLines.join(", ") + "\nAll must meet or exceed specs. Real Digi-Key parts only. Different manufacturers than " + originalPart.manufacturer + ".\nRespond ONLY with raw JSON starting with {:\n{\"mode\":\"alt\",\"originalPart\":\"" + originalPart.mpn + "\",\"originalSpecs\":\"" + specLines.join(", ") + "\",\"alternatives\":[{\"partNumber\":\"IRFB4115GPBF\",\"manufacturer\":\"Vishay\",\"type\":\"N-Channel MOSFET\",\"compatibility\":\"drop-in\",\"keySpecs\":[{\"label\":\"VDS\",\"value\":\"150\",\"unit\":\"V\"},{\"label\":\"ID\",\"value\":\"104\",\"unit\":\"A\"},{\"label\":\"RDS(on)\",\"value\":\"11\",\"unit\":\"m\\u03a9\"},{\"label\":\"Qg\",\"value\":\"120\",\"unit\":\"nC\"},{\"label\":\"Package\",\"value\":\"TO-220\",\"unit\":\"\"}],\"package\":\"TO-220\",\"whyAlternative\":\"reason\",\"differences\":\"key differences\"}],\"importantNote\":\"note\"}";
}

async function prefetchStock(partNumbers) {
  var stockResults = {};
  for (var i = 0; i < partNumbers.length; i++) {
    var mpn = partNumbers[i];
    if (!mpn) continue;
    var cached = getCached(stockCache, mpn);
    if (cached) { stockResults[mpn] = cached; continue; }
    var results = await Promise.all([lookupDigikey(mpn), lookupMouser(mpn)]);
    var dk = results[0]; var mouser = results[1];
    var total = (dk ? dk.stock : 0) + (mouser ? mouser.stock : 0);
    var bestPrice = null; var bestPriceSource = null;
    if (dk && dk.price) { bestPrice = dk.price; bestPriceSource = "Digi-Key"; }
    if (mouser && mouser.price) { var mv = parseFloat((mouser.price || "999").replace(/[^0-9.]/g, "")) || 999; var cv = parseFloat((bestPrice || "999").replace(/[^0-9.]/g, "")) || 999; if (mv < cv) { bestPrice = mouser.price; bestPriceSource = "Mouser"; } }
    var sr = { found: total > 0, totalStock: total, bestPrice: bestPrice, bestPriceSource: bestPriceSource, digikey: dk, mouser: mouser, octopartUrl: "https://octopart.com/search?q=" + encodeURIComponent(mpn) };
    setCache(stockCache, mpn, sr, STOCK_TTL);
    stockResults[mpn] = sr;
  }
  return stockResults;
}

// =============================================
// HEALTH
// =============================================
app.get("/api/health", function(req, res) {
  res.json({ status: "ok", service: "PartTensor", time: new Date().toISOString() });
});

// =============================================
// MAIN CHAT ENDPOINT
// DigiKey is the source of truth for part numbers
// AI only ranks and explains results
// =============================================
app.post("/api/chat", async function(req, res) {
  try {
    var message = req.body.message;
    var history = req.body.history || [];
    var isCorrection = req.body.isCorrection || false;
    if (!message) return res.status(400).json({ error: "Message is required" });
    console.log("\n[CHAT]", message.substring(0, 80));

    // Extract specs from message
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
      var originalPart = await fetchPartSpecs(pn);
      if (!originalPart) return res.json({ text: "Could not find specs for " + pn + " on DigiKey. Please check the part number.", intent: intent, mode: "question" });
      if (originalPart.isPassive) {
        return res.json({ text: "For **" + pn + "** (" + originalPart.categoryName + "), parametric search gives the most accurate alternatives.", mode: "passive_connector_alt", originalPart: pn, originalManufacturer: originalPart.manufacturer, originalDescription: originalPart.description, categoryName: originalPart.categoryName, searchLinks: [{ name: "Digi-Key Search", url: originalPart.dkSearchUrl, description: "Filter by specs" }, { name: "Mouser Search", url: originalPart.mouserSearchUrl, description: "In-stock alternatives" }, { name: "Octopart", url: originalPart.octopartUrl, description: "All distributors" }], tips: ["Category: " + originalPart.categoryName, originalPart.specsText.substring(0, 150)], intent: intent });
      }

      // Search DigiKey for alternatives using real component type
      var compType = detectComponentType(originalPart.description + " " + originalPart.categoryName);
      var dkProducts = null;
      if (compType) {
        var dkProducts2 = await searchDigikeyParametric(componentType, requiredSpecs, "");

      }

      if (!dkProducts || dkProducts.length === 0) {
        // Fallback to keyword search
        var altSystem = buildAltSystem(originalPart);
        var altResult = await callAI(altSystem, [{ role: "user", content: message }], 3000);
        var altData = altResult.text ? extractJSON(altResult.text) : null;
        if (!altData) return res.json({ text: "Had trouble finding alternatives for " + pn + ". Please try again.", intent: intent, mode: "text" });
        var altParts2 = altData.alternatives || [];
        var altStock2 = await prefetchStock(altParts2.map(function(p) { return p.partNumber; }));
        altData.stockData = altStock2;
        altData.mode = "alt";
        return res.json(Object.assign({ text: "Here are alternatives for **" + pn + "**:", intent: intent }, altData));
      }

      // Filter out the original part and same manufacturer
      dkProducts = dkProducts.filter(function(p) {
        return (p.ManufacturerProductNumber || "").toUpperCase() !== pn.toUpperCase();
      });

      // Convert and score
      var altParts = dkProducts.slice(0, 8).map(function(p) { return convertDKProduct(p, compType); });
      altParts = await enrichWithMouserStock(altParts);

      // Sort by stock then closeness
      altParts = altParts.sort(function(a, b) {
        var aStock = (a.stockData && a.stockData.totalStock) || 0;
        var bStock = (b.stockData && b.stockData.totalStock) || 0;
        if (bStock > 0 && aStock === 0) return 1;
        if (aStock > 0 && bStock === 0) return -1;
        var aScore = scorePartCloseness(a, originalPart.specs, compType);
        var bScore = scorePartCloseness(b, originalPart.specs, compType);
        return aScore - bScore;
      });

      altParts = altParts.slice(0, 4);

      // Build stockData map
      var altStockMap = {};
      for (var ai = 0; ai < altParts.length; ai++) {
        if (altParts[ai].stockData) altStockMap[altParts[ai].partNumber] = altParts[ai].stockData;
        altParts[ai].compatibility = "functional";
        altParts[ai].whyAlternative = "Real-time result from DigiKey matching specs of " + pn;
      }

      // AI enrichment - rank and explain only
      var enrichPrompt = "User asked for alternatives to " + pn + " (" + originalPart.description + "). Required specs: " + originalPart.specsText.substring(0, 200) + "\n\nParts from DigiKey:\n" + altParts.map(function(p, idx) { return (idx + 1) + ". " + p.partNumber + " by " + p.manufacturer + " - " + p.keySpecs.map(function(s) { return s.label + "=" + s.value + s.unit; }).join(", "); }).join("\n");
      var enrichResult = await callAI(ENRICHMENT_SYSTEM, [{ role: "user", content: enrichPrompt }], 1500);
      if (enrichResult.text) {
        var enrichData = extractJSON(enrichResult.text);
        if (enrichData && enrichData.rankedResults) {
          for (var ri = 0; ri < enrichData.rankedResults.length; ri++) {
            for (var pi2 = 0; pi2 < altParts.length; pi2++) {
              if (altParts[pi2].partNumber === enrichData.rankedResults[ri].partNumber) {
                altParts[pi2].rank = enrichData.rankedResults[ri].rank || "alternative";
                altParts[pi2].aeComment = enrichData.rankedResults[ri].aeComment || "";
                altParts[pi2].caution = enrichData.rankedResults[ri].caution || null;
                altParts[pi2].applications = enrichData.rankedResults[ri].applications || [];
              }
            }
          }
          var designTip2 = enrichData.designTip || "";
          return res.json({ text: "Here are **" + altParts.length + " real alternatives** for **" + pn + "** — sourced directly from DigiKey:", mode: "alt", originalPart: pn, originalSpecs: originalPart.specsText.substring(0, 200), alternatives: altParts, stockData: altStockMap, designTip: designTip2, importantNote: "Results sourced directly from DigiKey catalog.", intent: intent });
        }
      }

      return res.json({ text: "Here are **" + altParts.length + " real alternatives** for **" + pn + "** — sourced directly from DigiKey:", mode: "alt", originalPart: pn, alternatives: altParts, stockData: altStockMap, intent: intent });
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
      var bomText = "Here is a **sourcing-ready BOM** for your **" + bomData.projectName + "** — " + bomData.bomItems.length + " critical components:";
      var bomResponse = Object.assign({ text: bomText, intent: intent }, bomData);
      setCache(aiCache, bomCacheKey, bomResponse, AI_TTL);
      return res.json(bomResponse);
    }

    // PART SEARCH — DigiKey parametric search as source of truth
    var componentType = detectComponentType(message);
    console.log("Component type detected:", componentType);

    if (componentType) {
      // Step 1: Get real parts from DigiKey
      var dkProducts2 = await searchDigikeyParametric(componentType, requiredSpecs, message.replace(/[^a-zA-Z0-9\s]/g, " ").split(/\s+/).slice(0, 3).join(" "));

      if (dkProducts2 && dkProducts2.length > 0) {
        console.log("Got", dkProducts2.length, "real parts from DigiKey");

        // Step 2: Convert to our format
        var realParts = dkProducts2.slice(0, 10).map(function(p) { return convertDKProduct(p, componentType); });

        // Step 3: Enrich with Mouser stock
        realParts = await enrichWithMouserStock(realParts);

        // Step 4: Sort by stock then closeness to requested specs
        realParts = realParts.sort(function(a, b) {
          var aStock = (a.stockData && a.stockData.totalStock) || 0;
          var bStock = (b.stockData && b.stockData.totalStock) || 0;
          if (bStock > 0 && aStock === 0) return 1;
          if (aStock > 0 && bStock === 0) return -1;
          var aScore = scorePartCloseness(a, requiredSpecs, componentType);
          var bScore = scorePartCloseness(b, requiredSpecs, componentType);
          if (Math.abs(aScore - bScore) > 0.05) return aScore - bScore;
          return bStock - aStock;
        });

        // Take top 4
        realParts = realParts.slice(0, 4);

        // Step 5: Build stock data map
        var stockDataMap = {};
        for (var rpi = 0; rpi < realParts.length; rpi++) {
          if (realParts[rpi].stockData) stockDataMap[realParts[rpi].partNumber] = realParts[rpi].stockData;
        }

        // Step 6: AI enrichment — rank, explain, design tip only
        var enrichPrompt2 = "User asked: " + message + "\n\nReal parts from DigiKey matching their requirements:\n" +
          realParts.map(function(p, idx) {
            return (idx + 1) + ". " + p.partNumber + " by " + p.manufacturer + " | Stock: " + ((p.stockData && p.stockData.totalStock) || p.stock || 0) + " | Specs: " + p.keySpecs.map(function(s) { return s.label + "=" + s.value + s.unit; }).join(", ");
          }).join("\n");

        var enrichResult2 = await callAI(ENRICHMENT_SYSTEM, [{ role: "user", content: enrichPrompt2 }], 1500);
        var category2 = (DK_CATEGORIES[componentType] && DK_CATEGORIES[componentType].name) || componentType;
        var interpretation2 = "Real DigiKey results for " + message.substring(0, 60);
        var designTip3 = "";

        if (enrichResult2.text) {
          var enrichData2 = extractJSON(enrichResult2.text);
          if (enrichData2) {
            category2 = enrichData2.category || category2;
            interpretation2 = enrichData2.interpretation || interpretation2;
            designTip3 = enrichData2.designTip || "";
            if (enrichData2.rankedResults) {
              for (var ri2 = 0; ri2 < enrichData2.rankedResults.length; ri2++) {
                for (var pi3 = 0; pi3 < realParts.length; pi3++) {
                  if (realParts[pi3].partNumber === enrichData2.rankedResults[ri2].partNumber) {
                    realParts[pi3].rank = enrichData2.rankedResults[ri2].rank || "alternative";
                    realParts[pi3].aeComment = enrichData2.rankedResults[ri2].aeComment || "";
                    realParts[pi3].caution = enrichData2.rankedResults[ri2].caution || null;
                    realParts[pi3].applications = enrichData2.rankedResults[ri2].applications || [];
                  }
                }
              }
            }
          }
        }

        var searchResponse2 = {
          text: "Found **" + realParts.length + " real in-stock parts** from DigiKey — " + interpretation2 + ". Best match first:",
          mode: "search",
          category: category2,
          interpretation: interpretation2,
          results: realParts,
          stockData: stockDataMap,
          designTip: designTip3,
          intent: intent,
          source: "DigiKey parametric search",
        };

        return res.json(searchResponse2);
      }

      console.log("DigiKey parametric search returned no results, falling back to keyword search");
    }

    // FALLBACK: DigiKey keyword search + AI enrichment
    console.log("Falling back to keyword search");
    var kwToken = await getDigikeyToken();
    var kwResults = null;
    if (kwToken) {
      try {
        var fetch2 = (await import("node-fetch")).default;
        var kwRes = await fetch2("https://api.digikey.com/products/v4/search/keyword", {
          method: "POST",
          headers: { "Authorization": "Bearer " + kwToken, "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID, "X-DIGIKEY-Locale-Site": "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "USD", "Content-Type": "application/json" },
          body: JSON.stringify({ Keywords: componentType ? (DK_CATEGORIES[componentType] && DK_CATEGORIES[componentType].name) || "" : message.replace(/[^a-zA-Z0-9\s]/g, " ").substring(0, 60), Limit: 10,

        });
        if (kwRes.ok) {
          var kwData = await kwRes.json();
          kwResults = kwData.Products || [];
          console.log("Keyword search returned", kwResults.length, "products");
        }
      } catch (e) { console.error("Keyword search error:", e.message); }
    }

    if (kwResults && kwResults.length > 0) {
      var kwParts = kwResults.slice(0, 8).map(function(p) { return convertDKProduct(p, componentType); });
      kwParts = await enrichWithMouserStock(kwParts);
      kwParts = kwParts.sort(function(a, b) {
        var aStock = (a.stockData && a.stockData.totalStock) || 0;
        var bStock = (b.stockData && b.stockData.totalStock) || 0;
        return bStock - aStock;
      });
      kwParts = kwParts.slice(0, 4);
      var kwStockMap = {};
      for (var ki2 = 0; ki2 < kwParts.length; ki2++) { if (kwParts[ki2].stockData) kwStockMap[kwParts[ki2].partNumber] = kwParts[ki2].stockData; }

      var kwEnrichPrompt = "User asked: " + message + "\n\nParts from DigiKey:\n" + kwParts.map(function(p, idx) { return (idx + 1) + ". " + p.partNumber + " by " + p.manufacturer + " | " + p.keySpecs.map(function(s) { return s.label + "=" + s.value + s.unit; }).join(", "); }).join("\n");
      var kwEnrich = await callAI(ENRICHMENT_SYSTEM, [{ role: "user", content: kwEnrichPrompt }], 1000);
      var kwDesignTip = "";
      if (kwEnrich.text) {
        var kwEnrichData = extractJSON(kwEnrich.text);
        if (kwEnrichData) {
          kwDesignTip = kwEnrichData.designTip || "";
          if (kwEnrichData.rankedResults) {
            for (var kri = 0; kri < kwEnrichData.rankedResults.length; kri++) {
              for (var kpi = 0; kpi < kwParts.length; kpi++) {
                if (kwParts[kpi].partNumber === kwEnrichData.rankedResults[kri].partNumber) {
                  kwParts[kpi].rank = kwEnrichData.rankedResults[kri].rank || "alternative";
                  kwParts[kpi].aeComment = kwEnrichData.rankedResults[kri].aeComment || "";
                  kwParts[kpi].caution = kwEnrichData.rankedResults[kri].caution || null;
                  kwParts[kpi].applications = kwEnrichData.rankedResults[kri].applications || [];
                }
              }
            }
          }
        }
      }

      return res.json({ text: "Found **" + kwParts.length + " real parts** from DigiKey:", mode: "search", category: componentType || "Components", interpretation: message.substring(0, 80), results: kwParts, stockData: kwStockMap, designTip: kwDesignTip, intent: intent, source: "DigiKey keyword search" });
    }

    // Last resort: pure AI text response
    var fallback2 = await callAI(ENGINEERING_SYSTEM, fullMessages, 1500);
    return res.json({ text: fallback2.text || "Could not find specific parts. Please try a more specific query.", intent: intent, mode: "text" });

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
    for (var li = 1; li < lines.length; li++) {
      var cols = lines[li].split(",").map(function(c) { return c.replace(/"/g, "").trim(); });
      if (cols[pnColIdx]) partNumbers.push(cols[pnColIdx]);
    }
    if (partNumbers.length === 0) return res.status(400).json({ error: "No part numbers found." });
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
  console.log("  POST /api/chat — DigiKey parametric search + AI enrichment");
  console.log("  POST /api/excel-bom\n");
});
