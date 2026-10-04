import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { GEMINI_API_KEY, MODEL = 'gemini-3.1-flash-lite', PORT = 3000 } = process.env;
const DAILY_CAP = Number(process.env.DAILY_CAP) || 80;
const PER_HOUR = Number(process.env.SCANS_PER_HOUR) || 10;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Fallback: if index.html sits next to server.js instead of in public/, still serve it (only that one file).
app.get('/', (_req, res, next) => {
  const f = path.join(__dirname, 'index.html');
  existsSync(f) ? res.sendFile(f) : next();
});

// ---- limits -------------------------------------------------------------
let day = new Date().toDateString(), used = 0;
const dailyCap = (req, res, next) => {
  const today = new Date().toDateString();
  if (today !== day) { day = today; used = 0; }
  if (used >= DAILY_CAP) return res.status(429).json({ error: 'daily_cap' });
  next();
};
const perVisitor = rateLimit({
  windowMs: 60 * 60 * 1000, limit: PER_HOUR, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'hourly_cap' },
});

// ---- prompt -------------------------------------------------------------
const AUDIENCE = 'AUDIENCE: an everyday adult (including parents and older family members) who is not a nutrition expert but wants the real facts. Use plain, precise language and short sentences. If you must use a medical term, add a few simple words in brackets. Give numbers and thresholds where they matter. No fear-mongering, no filler.';
const LANGS = {
  en: 'English',
  hi: 'Hindi in Devanagari script (keep ingredient names and INS numbers exactly as printed on the label, in their original script)',
  hinglish: 'Hinglish: Hindi written in the Roman/English alphabet, the way Indians text (e.g. "Isme bohot zyada namak hai"). Keep ingredient names as printed.',
};

const FACTS = `
- INS 621 monosodium glutamate (MSG), flavour enhancer: JECFA set no numerical ADI; EFSA 2017 group ADI for glutamates 30 mg/kg bw/day. FSSAI permits it but not in foods for infants under 12 months. Effects: short-lived headache, flushing, sweating or numbness in some sensitive people after large doses; contains sodium (about one-third of table salt's); makes salty food easy to overeat. Evidence moderate. Level watch.
- INS 627 / 631 / 635 (disodium guanylate, inosinate, 5'-ribonucleotides), flavour enhancers made from purines: can raise uric acid, so people with gout or kidney stones should limit; not advised for infants. Evidence limited. Level watch.
- INS 102 tartrazine, 104 quinoline yellow, 110 sunset yellow FCF, 122 carmoisine, 124 ponceau 4R, 129 allura red, synthetic colours: EU requires the warning "may have an adverse effect on activity and attention in children" (2007 Southampton study); can trigger hives or asthma in sensitive people (tartrazine especially, in aspirin-sensitive people); no nutritional value; JECFA ADI exists (tartrazine 0-10 mg/kg bw). Evidence moderate. Level watch.
- INS 133 brilliant blue, 132 indigo carmine, 143 fast green: synthetic colours, low concern at permitted levels, no nutritional value. Evidence limited. Level watch.
- INS 150c / 150d caramel colour: can contain 4-methylimidazole (4-MEI), classed by IARC as Group 2B (possibly carcinogenic, from high-dose animal studies); levels in food are regulated. Evidence limited. Level watch.
- INS 211 sodium benzoate, 212 potassium benzoate, preservatives: can form small amounts of benzene with vitamin C under heat or light; linked with hyperactivity in children when combined with some dyes; may worsen asthma or hives in sensitive people; JECFA ADI 0-5 mg/kg bw (benzoic acid). Evidence moderate. Level watch.
- INS 200 sorbic acid, 202 potassium sorbate, preservatives: low concern; rare skin or mouth irritation. Level ok.
- INS 220-228 sulphites (sulphur dioxide, sodium metabisulphite 223): can trigger wheeze, asthma attacks and hives in sulphite-sensitive people (more often in asthmatics); destroy vitamin B1. Evidence strong. Level watch.
- INS 249-252 nitrites and nitrates, curing agents in processed meat: can form nitrosamines, some carcinogenic; IARC classes processed meat as Group 1 (carcinogenic to humans) and ingested nitrate/nitrite under conditions that favour nitrosation as Group 2A. Evidence strong. Level avoid.
- INS 320 BHA, 321 BHT, 319 TBHQ, synthetic antioxidants in oils, chips and noodles: BHA is IARC Group 2B (possibly carcinogenic, animal studies at high doses); large doses of TBHQ cause nausea; use limits set by FSSAI/JECFA (TBHQ ADI 0-0.7 mg/kg bw). Evidence limited. Level watch.
- INS 951 aspartame: IARC 2023 Group 2B (possibly carcinogenic, limited evidence) while JECFA kept ADI at 40 mg/kg bw/day; contains phenylalanine so people with phenylketonuria must avoid it; some people report headaches. Evidence limited. Level watch.
- INS 950 acesulfame K, 955 sucralose, 954 saccharin, 952 cyclamate, artificial sweeteners: JECFA/FSSAI limits apply; WHO 2023 guideline advises against non-sugar sweeteners for weight control; keep the craving for sweet alive; some lab studies raise questions about gut bacteria (and sucralose breakdown products). Evidence limited. Level watch.
- INS 407 carrageenan, seaweed thickener: EFSA/JECFA consider it safe at current use; may cause bloating or gut irritation in sensitive people; gut-inflammation findings in animals are not confirmed in humans. Evidence limited. Level watch.
- INS 410 locust bean gum, 412 guar gum, 415 xanthan gum: thickeners that act like fibre; low concern; large amounts can cause gas or loose stools. Level ok.
- INS 322 lecithin (soy or sunflower emulsifier): low concern; soy allergen if from soy. INS 471 mono- and diglycerides: low concern at permitted levels. Level ok.
- INS 450-452 polyphosphates, 339-341 phosphates, 338 phosphoric acid: high total phosphate intake is linked in studies with vascular calcification and bone and kidney effects, especially in kidney disease; phosphoric acid in colas is linked in some studies with lower bone density and tooth enamel erosion. Evidence moderate. Level watch.
- INS 508 potassium chloride (salt substitute): adds potassium; people with kidney disease or on potassium-raising BP medicines (ACE inhibitors, spironolactone) should avoid excess; can taste bitter or metallic. Evidence moderate. Level watch.
- INS 330 citric acid, 296 malic acid, 270 lactic acid, acidity regulators: low concern; frequent sipping of acidic drinks can wear tooth enamel. Level ok.
- Palm oil, palmolein, refined palm oil: about 50% saturated fat, which raises LDL cholesterol more than unsaturated oils; high-heat refining can form contaminants (3-MCPD and glycidyl esters; EFSA 2016 flagged potential concern for young high consumers); WHO advises saturated fat below 10% of energy. Evidence strong. Level watch, or avoid if it is among the first three ingredients.
- Hydrogenated or partially hydrogenated vegetable oil, vanaspati, shortening: may contain industrial trans fat, which raises LDL, lowers HDL and raises heart-disease risk at any intake; WHO calls for its elimination; FSSAI limits trans fat to 2% of total fat in oils/fats and foods made with them. Evidence strong. Level avoid.
- Sugar, sucrose, invert sugar, glucose syrup, liquid glucose, dextrose, fructose, high-fructose corn syrup, honey or jaggery used as added sugar (free sugars): WHO advises under 10% of energy, ideally under 5% (about 25 g, 6 tsp); linked to tooth decay, weight gain, type 2 diabetes and fatty liver at high intake. Evidence strong. Level watch, or avoid if first or second ingredient.
- Maltodextrin, modified starch (INS 14xx), dextrin: refined starch; maltodextrin has a high glycaemic index and raises blood sugar fast; some lab studies suggest effects on gut bacteria. Evidence limited. Level watch.
- Refined wheat flour, maida, white flour: bran and germ removed so little fibre; digests fast and raises blood sugar quickly; higher intake is linked with higher diabetes and weight risk compared with whole grains. Evidence moderate. Level watch.
- Salt, common salt, iodised salt, sodium chloride: WHO and ICMR-NIN advise under 5 g salt (2000 mg sodium) a day; excess raises blood pressure and stroke, heart and kidney risk. Evidence strong. Level watch, or avoid if the table shows over 40% of the daily sodium limit.
- Yeast extract, hydrolysed vegetable protein: natural source of glutamate (acts like MSG) and adds sodium; MSG-sensitive people may react. Evidence limited. Level watch.
- Flavours (natural or nature-identical): composition not disclosed; low concern alone but a marker of an ultra-processed product. Level ok.
`;

const prompt = (lang) => `You read food and drink labels from a photo and explain them honestly.
${AUDIENCE}
WRITE ALL TEXT FIELDS IN: ${LANGS[lang]}.

RULES
- Use ONLY what is visible on the label. Never invent numbers. If a value is not printed, return null.
- STEP 1, TRANSCRIBE FIRST: before analysing anything, copy the ingredient list into ingredientsText and the nutrition table into nutritionText, exactly as printed (same language, spelling, numbers and units). Use "" if that section is not visible. Then build every other field only from these two transcriptions and other text clearly printed on the pack. Do not use what you know about the brand or product name to fill gaps or assume a recipe.
- If ingredients are printed in several languages, use ONE complete list (English if available, else the clearest one) and do not repeat ingredients.
- Keep ingredient order exactly as printed; put sub-ingredients right after their parent. Do not merge, reorder, drop or add rows. If a word is cut off or blurred, copy only what is readable, do not complete it by guessing, and lower readQuality.
- Nutrition numbers: never mix the per-serving and per-100 g columns. Use per serving if printed, else per 100 g. Watch units carefully (g vs mg, kJ vs kcal; take kcal as printed, only convert from kJ by dividing by 4.184 if kcal is absent). "<0.5 g", "trace" or "nil" counts as 0.
- sugarG is TOTAL sugars. addedSugarG only if an "added sugars" line is printed, otherwise null (never copy sugarG into it). sodiumMg: use printed sodium; if only salt is printed, sodium mg = salt g x 400.
- SELF-CHECK before answering: saturated fat <= total fat; trans fat <= total fat; added sugar <= total sugar; per-100 g values never above 100 g; every ingredient in ingredientsText appears once in ingredients and nothing appears that is not on the label. If a number fails, re-read the image; if still unsure return null and lower readQuality.
- Nutrition: use the "per serving" column if printed, else "per 100 g/ml" and set basis accordingly. Convert salt to sodium if needed (sodium mg = salt g x 400).
- Ingredients: list EVERY ingredient in exact label order, including INS/E numbers and sub-ingredients in brackets as separate rows. Set "percent" only if a % is printed.
- name: copy EXACTLY as printed on the label. plainName: what it really is, in everyday words, max 14 words, for EVERY ingredient (e.g. "Tartrazine (INS 102)" -> "Man-made yellow food dye"; "Maltodextrin" -> "Starch powder that acts like sugar"; "Palm oil" -> "Cheap vegetable oil from palm fruit").
- For each ingredient give: role (why added, max 8 words); affects (body systems/groups it can harm, max 10 words, "" if none); sideEffects (array of 2-5 specific, documented side effects, each max 8 words, e.g. "raises LDL cholesterol", "may trigger migraine in sensitive people"; [] only if truly none are known); atNormalDose (one sentence: what applies even at the amount normally found in food, or the accepted daily limit/ADI; "" if none); regularUse (what can build up with regular long-term intake, one precise sentence, "" if none); avoidIf (who should limit it, max 12 words, ""); regulatory (one short line if it is restricted/banned somewhere or has an FSSAI/EFSA/WHO limit or classification, else ""); evidence strong/moderate/limited/none; level ok/watch/avoid.
- IMPORTANT: do NOT skip side effects just because the quantity is small or within legal limits. Every additive, preservative, colour, artificial sweetener, flavour enhancer, refined/hydrogenated fat, refined flour, and high sugar/sodium ingredient with any documented side effect must be level watch or avoid, with its sideEffects listed, and you must say plainly when effects are dose-dependent. Only truly benign ingredients (water, plain spices, whole grains, etc.) are ok.
- Be accurate, not alarmist. Do not label something harmful without real evidence; water, spices, plain flour etc. are "ok". Mention dose-dependence where it matters. Respect Indian context (FSSAI, ICMR, INS numbers) when relevant.
- keyPoints: 3-5 short facts (max 18 words each, with numbers when printed) covering the biggest positives and negatives, most important first. level ok/watch/avoid.
- category: 1-2 words for the ingredient type (e.g. Sweetener, Refined oil, Preservative, Colour, Salt, Whole grain, Spice).
- verdict.headline max 10 words; verdict.summary max 40 words and must name the 1-3 biggest issues with numbers if available.
- swaps: 2-3 simple, cheaper-or-easier Indian-context alternatives. flags: short tags like "Ultra-processed", "High sodium", "Contains palm oil", "Artificial colour".
- allergens: only those printed on the label.
- nova: NOVA food-processing group 1-4. Use 4 (ultra-processed) if the ingredients include substances not used in home kitchens: flavour enhancers, colours, emulsifiers, artificial sweeteners, hydrogenated oils, maltodextrin, modified starch, HFCS, protein isolates or flavourings. 3 = processed (salt, sugar or oil added to whole foods), 2 = culinary ingredient, 1 = unprocessed or minimal.
- frequency: one practical sentence (max 22 words) on how often and how much is reasonable, based ONLY on this label's numbers and ingredients.
- readQuality: "high" if all text was clearly legible; "medium" or "low" if parts were blurry, cut off or you had to guess; note says what is missing (max 16 words, "" if high). Never guess unreadable values: use null.
- basis (per ingredient): max 14 words naming the authority and fact, e.g. "JECFA ADI 0-5 mg/kg; EU child-activity warning"; "" if you have no solid source. Cite only WHO, FSSAI, ICMR-NIN, JECFA, EFSA, IARC or AHA. Never invent study names, years, numbers or regulations.
- REFERENCE FACTS below are authoritative. When an ingredient matches an entry (by INS number or name), use those facts and never contradict them; translate them faithfully. You may add other well-established facts, but if unsure say less and use hedged wording ("may", "in sensitive people"). Use the stricter level when the label context calls for it.
REFERENCE FACTS:
${FACTS}
- If the image is not a food/drink label or is unreadable, set isLabel=false and explain in verdict.summary.`;

const N = { type: 'NUMBER', nullable: true };
const Str = { type: 'STRING' };
const schema = {
  type: 'OBJECT',
  required: ['isLabel', 'ingredientsText', 'nutritionText', 'productName', 'verdict', 'keyPoints', 'nova', 'frequency', 'readQuality', 'nutrition', 'ingredients', 'swaps', 'flags', 'allergens'],
  // Transcription comes first so the model reads the label before it analyses it.
  propertyOrdering: ['isLabel', 'ingredientsText', 'nutritionText', 'productName', 'readQuality', 'nutrition', 'ingredients', 'nova', 'flags', 'allergens', 'keyPoints', 'verdict', 'frequency', 'swaps'],
  properties: {
    isLabel: { type: 'BOOLEAN' }, nova: { type: 'INTEGER' }, frequency: Str,
    ingredientsText: Str, nutritionText: Str,
    readQuality: { type: 'OBJECT', required: ['level', 'note'], properties: { level: { type: 'STRING', enum: ['high', 'medium', 'low'] }, note: Str } },
    productName: Str,
    verdict: { type: 'OBJECT', required: ['level', 'headline', 'summary'],
      properties: { level: { type: 'STRING', enum: ['ok', 'watch', 'avoid'] }, headline: Str, summary: Str } },
    keyPoints: { type: 'ARRAY', items: { type: 'OBJECT', required: ['level', 'text'],
      properties: { level: { type: 'STRING', enum: ['ok', 'watch', 'avoid'] }, text: Str } } },
    nutrition: { type: 'OBJECT',
      properties: { basis: { type: 'STRING', enum: ['serving', '100g'] }, servingSize: { type: 'STRING', nullable: true },
        sugarG: N, addedSugarG: N, sodiumMg: N, totalFatG: N, satFatG: N, transFatG: N, fibreG: N, proteinG: N, kcal: N } },
    ingredients: { type: 'ARRAY', items: { type: 'OBJECT', required: ['name', 'plainName', 'category', 'role', 'affects', 'sideEffects', 'atNormalDose', 'regularUse', 'regulatory', 'basis', 'avoidIf', 'evidence', 'level'],
      properties: { name: Str, plainName: Str, basis: Str, category: Str, ins: { type: 'STRING', nullable: true }, percent: N, role: Str, affects: Str, sideEffects: { type: 'ARRAY', items: Str }, atNormalDose: Str, regulatory: Str,
        regularUse: Str, avoidIf: Str, evidence: { type: 'STRING', enum: ['strong', 'moderate', 'limited', 'none'] },
        level: { type: 'STRING', enum: ['ok', 'watch', 'avoid'] } } } },
    swaps: { type: 'ARRAY', items: Str },
    flags: { type: 'ARRAY', items: Str },
    allergens: { type: 'ARRAY', items: Str },
  },
};

// ---- sanity checks on the model's answer -------------------------------------
// Catches impossible numbers and keeps well-known additives from being rated too leniently.
const RANK = { ok: 0, watch: 1, avoid: 2 };
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
const AVOID_INS = new Set(['249', '250', '251', '252']);
const WATCH_INS = new Set([
  '102', '104', '110', '122', '124', '129', '132', '133', '143', '150c', '150d',
  '211', '212', '319', '320', '321', '338', '339', '340', '341', '407', '508',
  '621', '627', '631', '635', '950', '951', '952', '954', '955',
  ...range(220, 228), ...range(450, 452),
]);
const insCode = (ing) => {
  const src = `${ing.ins || ''} ${/\b(?:INS|E)\s?\d/i.test(ing.name || '') ? ing.name : ''}`;
  const m = src.match(/(?:INS|E)?\s?(\d{3,4}[a-d]?)\b/i);
  return m ? m[1].toLowerCase() : null;
};
const sanitize = (d) => {
  if (!d || d.isLabel === false) return d;
  const n = d.nutrition || (d.nutrition = {});
  const hidden = [];
  const drop = (k) => { if (n[k] != null) { n[k] = null; hidden.push(k); } };
  const grams = ['sugarG', 'addedSugarG', 'totalFatG', 'satFatG', 'transFatG', 'fibreG', 'proteinG'];
  for (const k of [...grams, 'sodiumMg', 'kcal']) {
    if (n[k] != null && (typeof n[k] !== 'number' || !Number.isFinite(n[k]) || n[k] < 0)) drop(k);
  }
  if (n.basis === '100g') {
    for (const k of grams) if (n[k] > 100) drop(k);
    if (n.kcal > 900) drop('kcal');
    if (n.sodiumMg > 40000) drop('sodiumMg');
  }
  if (n.satFatG != null && n.totalFatG != null && n.satFatG > n.totalFatG + 0.05) drop('satFatG');
  if (n.transFatG != null && n.totalFatG != null && n.transFatG > n.totalFatG + 0.05) drop('transFatG');
  if (n.addedSugarG != null && n.sugarG != null && n.addedSugarG > n.sugarG + 0.05) drop('addedSugarG');

  let raised = false;
  for (const ing of d.ingredients || []) {
    const code = insCode(ing);
    const floor = code && (AVOID_INS.has(code) ? 'avoid' : WATCH_INS.has(code) ? 'watch' : null);
    if (floor && RANK[ing.level] < RANK[floor]) { ing.level = floor; raised = true; }
  }
  if (raised && d.verdict && d.verdict.level === 'ok') d.verdict.level = 'watch';

  const rq = d.readQuality || (d.readQuality = { level: 'high', note: '' });
  if (hidden.length && rq.level === 'high') {
    rq.level = 'medium';
    rq.note = 'Some numbers looked inconsistent and were hidden.';
  }
  if (d.ingredientsText && !(d.ingredients || []).length) {
    rq.level = 'low';
    rq.note = rq.note || 'Ingredients could not be read reliably.';
  }
  return d;
};

// ---- Gemini call with retries ----------------------------------------------
// Tries MODEL, then FALLBACK_MODEL (optional, set in .env) if still overloaded.
const ATTEMPTS = [MODEL, process.env.FALLBACK_MODEL || MODEL].filter(Boolean); // max 2 tries: retries also use up free quota
const sleep = ms => new Promise(r => setTimeout(r, ms));
const callGemini = (model, body) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
  signal: AbortSignal.timeout(60_000),
  body,
});

// ---- route --------------------------------------------------------------
app.post('/api/scan', perVisitor, dailyCap, async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'no_key' });
  let { image, mime = 'image/jpeg', lang = 'en' } = req.body || {};
  if (!LANGS[lang]) lang = 'en';
  if (typeof image !== 'string' || !/^image\/(jpeg|png|webp)$/.test(mime) || image.length > 7_000_000)
    return res.status(400).json({ error: 'bad_image' });

  used++;
  try {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt(lang) }, { inline_data: { mime_type: mime, data: image } }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0, maxOutputTokens: 12000 },
    });
    let r;
    for (const [i, model] of ATTEMPTS.entries()) {
      r = await callGemini(model, body);
      if (r.status !== 503 && r.status !== 500) break; // only retry temporary overloads
      if (i < ATTEMPTS.length - 1) { console.warn(`Gemini ${r.status} on ${model}, retrying...`); await sleep(1500 * (i + 1)); }
    }
    if (!r.ok) {
      console.error('Gemini', r.status, (await r.text()).slice(0, 300));
      used--;
      return res.status(r.status === 429 || r.status === 503 ? r.status : 502)
        .json({ error: r.status === 429 || r.status === 503 ? 'google_limit' : 'upstream' });
    }
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    res.json(sanitize(JSON.parse(text)));
  } catch (e) {
    console.error('scan failed:', e.message);
    res.status(502).json({ error: 'upstream' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL, left: DAILY_CAP - used }));

app.listen(PORT, () => console.log(`Label Platform on http://localhost:${PORT}`));
