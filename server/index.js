const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dayjs = require("dayjs");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const webpush = require("web-push");
const cron = require("node-cron");

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 5050;
const DATA_DIR = path.join(__dirname, "data");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const TARGETS_PATH = path.join(DATA_DIR, "targets.json");
const SUBS_PATH = path.join(DATA_DIR, "subscriptions.json");

app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function readJson(filePath, fallback) {
  try {
    const data = await fsp.readFile(filePath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function dateKey(date = new Date()) {
  return dayjs(date).format("YYYY-MM-DD");
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map((v) => Number(v));
  return h * 60 + m;
}

function isWithinQuietHours(nowMinutes, quiet) {
  const start = timeToMinutes(quiet.start);
  const end = timeToMinutes(quiet.end);
  if (start === end) return false;
  if (start < end) {
    return nowMinutes >= start && nowMinutes < end;
  }
  return nowMinutes >= start || nowMinutes < end;
}

function normalizeSummary(summary) {
  const base = {
    protein_servings: 0,
    veg_servings: 0,
    carb_servings: 0,
    snack_servings: 0,
    water_ml: 0
  };
  return { ...base, ...summary };
}

async function ensureLog(dateStr) {
  ensureDir(LOGS_DIR);
  const logPath = path.join(LOGS_DIR, `${dateStr}.json`);
  const existing = await readJson(logPath, null);
  if (existing) return { log: existing, path: logPath };
  const blank = {
    date: dateStr,
    checkins: {},
    consumed: normalizeSummary({}),
    entries: []
  };
  await writeJson(logPath, blank);
  return { log: blank, path: logPath };
}

async function getTargets() {
  return readJson(TARGETS_PATH, {
    protein_servings: 3,
    veg_servings: 3,
    carb_servings: 2,
    snack_servings: 1,
    water_ml: 2000
  });
}

async function getSettings() {
  return readJson(SETTINGS_PATH, {
    intervalMinutes: 20,
    quietHours: { start: "22:00", end: "07:00" },
    meals: [
      { id: "breakfast", label: "Fruehstueck", time: "09:00", windowMinutes: 120 },
      { id: "lunch", label: "Mittagessen", time: "13:00", windowMinutes: 120 },
      { id: "snack", label: "Snack", time: "16:30", windowMinutes: 120 },
      { id: "dinner", label: "Abendessen", time: "19:30", windowMinutes: 150 }
    ]
  });
}

async function getSubscriptions() {
  return readJson(SUBS_PATH, []);
}

async function saveSubscriptions(list) {
  await writeJson(SUBS_PATH, list);
}

function calcRemaining(targets, consumed) {
  const remaining = {};
  Object.keys(targets).forEach((key) => {
    remaining[key] = Math.max(0, targets[key] - (consumed[key] || 0));
  });
  return remaining;
}

function buildNagPayload(slot, remaining) {
  return JSON.stringify({
    title: `Check-in: ${slot.label}`,
    body: `Bitte bestaetigen. Offen: P ${remaining.protein_servings}, G ${remaining.veg_servings}, K ${remaining.carb_servings}`,
    tag: `meal-${slot.id}`
  });
}

async function sendPushToAll(payload) {
  const subs = await getSubscriptions();
  if (!subs.length) return { sent: 0 };
  const results = await Promise.allSettled(
    subs.map((sub) => webpush.sendNotification(sub, payload))
  );
  const stillValid = [];
  results.forEach((res, idx) => {
    if (res.status === "fulfilled") stillValid.push(subs[idx]);
  });
  if (stillValid.length !== subs.length) {
    await saveSubscriptions(stillValid);
  }
  return { sent: stillValid.length };
}

function ensureVapid() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    return false;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:you@example.com",
    pub,
    priv
  );
  return true;
}

const nagState = {};

async function handleNagCheck() {
  if (!ensureVapid()) return;
  const settings = await getSettings();
  const targets = await getTargets();
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (isWithinQuietHours(nowMinutes, settings.quietHours)) return;

  const today = dateKey(now);
  const { log } = await ensureLog(today);
  const remaining = calcRemaining(targets, log.consumed || {});

  for (const slot of settings.meals) {
    const slotStart = timeToMinutes(slot.time);
    const slotEnd = slotStart + slot.windowMinutes;
    if (nowMinutes < slotStart || nowMinutes > slotEnd) continue;
    if (log.checkins && log.checkins[slot.id]) continue;

    const key = `${today}-${slot.id}`;
    const lastSent = nagState[key] || 0;
    const interval = settings.intervalMinutes || 20;
    if (Date.now() - lastSent < interval * 60 * 1000) continue;

    const payload = buildNagPayload(slot, remaining);
    await sendPushToAll(payload);
    nagState[key] = Date.now();
  }
}

cron.schedule("* * * * *", () => {
  handleNagCheck().catch(() => null);
});

app.get("/api/status", async (req, res) => {
  const date = req.query.date || dateKey();
  const targets = await getTargets();
  const { log } = await ensureLog(date);
  const consumed = normalizeSummary(log.consumed || {});
  res.json({
    date,
    targets,
    consumed,
    remaining: calcRemaining(targets, consumed),
    checkins: log.checkins || {}
  });
});

app.get("/api/settings", async (req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

app.post("/api/settings", async (req, res) => {
  const settings = req.body || {};
  await writeJson(SETTINGS_PATH, settings);
  res.json({ ok: true });
});

app.get("/api/targets", async (req, res) => {
  const targets = await getTargets();
  res.json(targets);
});

app.post("/api/targets", async (req, res) => {
  const targets = req.body || {};
  await writeJson(TARGETS_PATH, targets);
  res.json({ ok: true });
});

app.post("/api/checkin", async (req, res) => {
  const slotId = req.body?.slotId;
  if (!slotId) return res.status(400).json({ error: "slotId required" });
  const date = dateKey();
  const { log, path: logPath } = await ensureLog(date);
  log.checkins = log.checkins || {};
  log.checkins[slotId] = true;
  await writeJson(logPath, log);
  res.json({ ok: true });
});

app.post("/api/subscribe", async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "invalid subscription" });
  const subs = await getSubscriptions();
  const exists = subs.some((s) => s.endpoint === sub.endpoint);
  if (!exists) subs.push(sub);
  await saveSubscriptions(subs);
  res.json({ ok: true });
});

app.post("/api/unsubscribe", async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "invalid subscription" });
  const subs = await getSubscriptions();
  const filtered = subs.filter((s) => s.endpoint !== sub.endpoint);
  await saveSubscriptions(filtered);
  res.json({ ok: true });
});

app.post("/api/push-test", async (req, res) => {
  if (!ensureVapid()) return res.status(500).json({ error: "missing VAPID keys" });
  const payload = JSON.stringify({ title: "Meal Coach", body: "Test-Erinnerung", tag: "test" });
  const result = await sendPushToAll(payload);
  res.json({ ok: true, ...result });
});

app.post("/api/log-meal", async (req, res) => {
  const date = req.body?.date || dateKey();
  const summary = normalizeSummary(req.body?.summary || {});
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const { log, path: logPath } = await ensureLog(date);
  log.consumed = normalizeSummary({
    protein_servings: (log.consumed?.protein_servings || 0) + summary.protein_servings,
    veg_servings: (log.consumed?.veg_servings || 0) + summary.veg_servings,
    carb_servings: (log.consumed?.carb_servings || 0) + summary.carb_servings,
    snack_servings: (log.consumed?.snack_servings || 0) + summary.snack_servings,
    water_ml: (log.consumed?.water_ml || 0) + summary.water_ml
  });
  log.entries.push({ at: new Date().toISOString(), items, summary });
  await writeJson(logPath, log);
  const targets = await getTargets();
  res.json({
    ok: true,
    consumed: log.consumed,
    remaining: calcRemaining(targets, log.consumed)
  });
});

app.post("/api/analyze-meal", upload.single("image"), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY missing" });
  }
  if (!req.file) return res.status(400).json({ error: "image required" });

  const prompt = `Du bist ein Ernaehrungsassistent. Schaetze Kategorien und Portionen.
Gib JSON exakt nach Schema zurueck. Nutze Portionen: 0.5, 1, 1.5, 2.
Wenn unsicher, konservativ schaetzen. Schreibe die note auf Deutsch.`;

  const schema = {
    name: "meal_analysis",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              category: { type: "string", enum: ["protein", "carb", "veg", "fat", "snack", "drink"] },
              estimated_amount: { type: "string" },
              servings: { type: "number" }
            },
            required: ["name", "category", "estimated_amount", "servings"]
          }
        },
        summary: {
          type: "object",
          additionalProperties: false,
          properties: {
            protein_servings: { type: "number" },
            veg_servings: { type: "number" },
            carb_servings: { type: "number" },
            snack_servings: { type: "number" },
            water_ml: { type: "number" }
          },
          required: ["protein_servings", "veg_servings", "carb_servings", "snack_servings", "water_ml"]
        },
        note: { type: "string" }
      },
      required: ["items", "summary", "note"]
    }
  };

  try {
    const base64 = req.file.buffer.toString("base64");
    const imageUrl = `data:${req.file.mimetype};base64,${base64}`;

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageUrl }
          ]
        }
      ],
      response_format: { type: "json_schema", json_schema: schema }
    });

    const text = response.output_text;
    const parsed = JSON.parse(text);
    const summary = normalizeSummary(parsed.summary || {});

    const date = dateKey();
    const { log, path: logPath } = await ensureLog(date);
    log.consumed = normalizeSummary({
      protein_servings: (log.consumed?.protein_servings || 0) + summary.protein_servings,
      veg_servings: (log.consumed?.veg_servings || 0) + summary.veg_servings,
      carb_servings: (log.consumed?.carb_servings || 0) + summary.carb_servings,
      snack_servings: (log.consumed?.snack_servings || 0) + summary.snack_servings,
      water_ml: (log.consumed?.water_ml || 0) + summary.water_ml
    });
    log.entries.push({ at: new Date().toISOString(), items: parsed.items, summary });
    await writeJson(logPath, log);

    const targets = await getTargets();
    res.json({
      ok: true,
      analysis: parsed,
      consumed: log.consumed,
      remaining: calcRemaining(targets, log.consumed)
    });
  } catch (err) {
    res.status(500).json({ error: "analysis_failed" });
  }
});

app.listen(PORT, () => {
  ensureDir(DATA_DIR);
  ensureDir(LOGS_DIR);
  console.log(`Server running on ${PORT}`);
});
