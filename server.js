import express from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || "gemini-flash-latest"; // any free Gemini Flash model works
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "gemini-3.1-flash-lite"; // used when the main model is overloaded
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCANS_PER_HOUR = Number(process.env.SCANS_PER_HOUR || 10); // per visitor IP
const DAILY_CAP = Number(process.env.DAILY_CAP || 80); // total scans per day, keeps you inside the free quota
const KEY = () => process.env.GEMINI_API_KEY;

let capDay = new Date().toDateString(), capUsed = 0;
function takeDailySlot() {
  const today = new Date().toDateString();
  if (today !== capDay) { capDay = today; capUsed = 0; }
  if (capUsed >= DAILY_CAP) return false;
  capUsed++;
  return true;
}

const app = express();
app.set("trust proxy", 1); // needed behind Render / Railway / Fly proxies
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PERSONAS = {
  general: "a general healthy adult.",
  diabetic: "a person managing diabetes. Focus on sugars, refined carbohydrates and how fast it raises blood sugar.",
  heart: "a person managing blood pressure or heart health. Focus on sodium, saturated fat and trans fat.",
  kids: "a parent feeding a child under 12. Focus on artificial colours, caffeine, flavour enhancers, sugar and sodium.",
  gluten: "someone avoiding gluten. Look for wheat, barley, rye, malt, and any may-contain warnings.",
  vegan: "a vegan. Look for milk, whey, ghee, gelatin, honey, carmine (INS 120), shellac (INS 904) and other animal-derived items."
};

function buildPrompt(persona) {
  return `You are reading one to three photos of a packaged food or drink label from any country, in any language. The photos may show the ingredient list, the nutrition table, or both; combine them into one product. Translate everything into plain English. Extract what is printed and reply with ONLY one JSON object, nothing else.

Schema:
{
 "readable": true or false,           // false if the photos are not a food or drink label, or the text cannot be read
 "productName": string or null,
 "language": string or null,          // language(s) printed on the label
 "unit": "g" or "ml",
 "servingSizeG": number or null,
 "servingsPerPack": number or null,
 "packSizeG": number or null,
 "per100g": { "energyKcal":n, "proteinG":n, "carbsG":n, "totalSugarG":n, "addedSugarG":n, "fatG":n, "satFatG":n, "transFatG":n, "fibreG":n, "sodiumMg":n },
 "summary": string,                    // one fair, plain sentence, max 25 words
 "personaCheck": { "status":"ok"|"watch"|"flag", "message":string },  // max 30 words, only about the profile below
 "topConcerns": [ { "title":string, "detail":string } ],  // 2 to 4 most important things a buyer should know, most important first. title max 6 words; detail max 30 words with concrete numbers from the label
 "interactions": [ { "ingredients":[string], "title":string, "effect":string, "basis":"established"|"plausible" } ],  // up to 4, [] if none
 "swaps": [ { "name":string, "why":string } ],  // exactly 2 simple, easy-to-find alternatives (generic foods, never brand names), "why" max 12 words
 "ingredients": [ { "name":string, "percent":number or null, "category":"whole"|"refined"|"sugar"|"salt"|"fat"|"additive"|"flavour"|"colour"|"preservative"|"other", "ins":string or null, "level":"ok"|"watch"|"flag", "note":string, "concern":string or null, "who":string or null, "evidence":"strong"|"moderate"|"limited"|"none", "regulatory":string or null, "contributes":"sugar"|"sodium"|"fat"|"satFat"|"carbs"|"fibre"|"protein"|null, "systems":[ { "system":"metabolic"|"renal"|"cardiovascular"|"musculoskeletal"|"digestive", "direction":"adverse"|"beneficial", "weight":1|2|3, "effect":string } ] } ]
}

Rules:
- Every nutrient is per 100 g (or 100 ml). If the label only shows per-serving values, convert using the serving size. If a value is not printed, use null. Never guess numbers. If sodium is not printed but salt is, convert salt g x 400 to sodium mg. Convert kJ to kcal by dividing by 4.184.
- Ingredients: keep the exact order on the label. Use short plain English names. Where an ingredient has bracketed sub-ingredients, list the parent first and then each sub-ingredient right after it. Set "percent" only when a percentage is printed on the label, otherwise null.
- Category "sugar" covers every sugar source: sugar, jaggery, glucose, dextrose, maltodextrin, invert syrup, fructose, honey, liquid glucose, corn syrup, malt extract.
- "ins" is the INS or E number if printed (for example "330" or "627, 631"), otherwise null.
- "level": be fair, not alarmist. "flag" only for things that are a real concern for regular eating (hydrogenated fat, artificial colours, flavour enhancers like INS 627/631, large amounts of added sugar high in the list). "watch" for refined flour, palm oil, salt, sugars, preservatives and similar. "ok" for whole foods and harmless additives.
- "note": max 14 words, plain language: what the ingredient is and why it is used.
- "concern": only for level "watch" or "flag" (null for "ok"). The specific health issue linked to regular intake, and how amount matters. Max 28 words. Be accurate and precise: say "linked to" or "may" unless the effect is well established, and say when an effect is only seen at high doses or only in animal studies. Never exaggerate.
- "who": groups who should take extra care (for example people with high BP, diabetes, gout, kidney disease, children, pregnancy). Max 10 words, or null.
- "evidence": how solid the human research behind the concern is. "strong" = consistent human studies or consensus guidance, "moderate" = some good human studies, "limited" = mostly animal or lab studies or small studies, "none" = no known concern.
- "regulatory": one short phrase on official status or guidance (for example a WHO limit or that it is permitted by FSSAI). Include it only if you are certain. Never invent numbers or limits. Otherwise null.
- "contributes": the one nutrient this ingredient mainly adds to the product: sugar for sugars, sodium for salt and sodium-based additives, fat or satFat for oils and fats, carbs for flours and starches, fibre for bran and gums, protein for protein sources. Use null for additives with no meaningful nutrient.
- "systems": body systems with credible evidence of an effect from this ingredient at normal dietary intake. "weight": 1 = minor or plausible, 2 = moderate, 3 = well established and relevant at typical intake. "effect": max 14 words, neutral clinical tone, no alarm words. Use [] when there is no credible effect. Never invent effects to fill the list.
- "interactions": up to 4 combinations of 2 or 3 ingredients from THIS label whose combined effect differs from the sum of the parts (for example several fast-absorbed carbohydrates stacking on the glycaemic response, or a flavour enhancer driving higher salt intake). "ingredients" must use the exact names from your ingredients list. "title" max 8 words, "effect" max 32 words, "basis" is "established" (documented in human studies or standard references) or "plausible" (reasonable mechanism, limited direct evidence). Use [] if there are none. Never invent interactions.
- "topConcerns": use only numbers printed on the label or simple arithmetic from them (for example a serving's sodium as a share of the WHO limit of 2,000 mg a day). If the product has few concerns, say so and name one or two genuine positives.
- Profile for personaCheck: ${PERSONAS[persona]}
- Set "readable" to true if you can see ANY part of a food or drink label: an ingredient list, a nutrition table, or both. If only one of them is visible, fill that part and use [] for ingredients or null for the nutrients. Never return readable false just because one part is missing.
- Return {"readable": false} only if the photos show no food or drink label text at all (a face, a person, scenery, an object) or are completely unreadable.`;
}

function extractJson(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a === -1 || b <= a) throw new Error("no json");
  return JSON.parse(text.slice(a, b + 1));
}

const scanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: SCANS_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ code: "rate_limited" })
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: Boolean(KEY()) });
});

app.post("/api/scan", scanLimiter, async (req, res) => {
  if (!KEY()) return res.status(503).json({ code: "not_configured" });

  const { images, persona = "general" } = req.body || {};
  if (!Array.isArray(images) || images.length < 1 || images.length > 3 || !PERSONAS[persona]) {
    return res.status(400).json({ code: "image_rejected" });
  }
  const blocks = [];
  for (const img of images) {
    const m = typeof img === "string" && img.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!m || m[2].length > 6_000_000) return res.status(400).json({ code: "image_rejected" });
    blocks.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }

  if (!takeDailySlot()) return res.status(429).json({ code: "daily_cap" });

  try {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [...blocks, { text: buildPrompt(persona) }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
    });
    const models = [MODEL, ...(FALLBACK_MODEL && FALLBACK_MODEL !== MODEL ? [FALLBACK_MODEL] : [])];
    const busy = st => st === 500 || st === 503;
    let r;
    for (const model of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": KEY() },
          body
        });
        if (!busy(r.status)) break;
        console.warn(`${model} busy (${r.status}), attempt ${attempt + 1}`);
        await sleep(1500 * (attempt + 1));
      }
      if (!busy(r.status)) break;
    }
    if (!r.ok) {
      console.error("gemini error:", r.status, (await r.text()).slice(0, 300));
      return res.status(r.status === 429 ? 429 : 502).json({ code: r.status === 429 ? "rate_limited" : "server_error" });
    }
    const j = await r.json();
    const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    const parsed = extractJson(text);
    if (parsed.readable === false || !Array.isArray(parsed.ingredients) || !parsed.ingredients.length) {
      console.log("MODEL REPLY (no ingredients found):", text.slice(0, 600));
    }
    res.json(parsed); // nothing is stored: images live only for this request
  } catch (err) {
    console.error("scan failed:", err?.message || err);
    if (err instanceof SyntaxError || err?.message === "no json") return res.status(502).json({ code: "invalid_json" });
    res.status(502).json({ code: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log(`Label platform running on http://localhost:${PORT}`);
  if (!KEY()) console.warn("GEMINI_API_KEY is not set: scanning is disabled until you add it.");
});
