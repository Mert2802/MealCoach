const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dayjs = require("dayjs");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const webpush = require("web-push");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

dotenv.config();

admin.initializeApp();
const db = admin.firestore();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "15mb" }));

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const VAPID_PUBLIC_KEY = defineSecret("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = defineSecret("VAPID_PRIVATE_KEY");
const VAPID_SUBJECT = defineSecret("VAPID_SUBJECT");

function getConfig() {
  const clean = (value) => (value ? String(value).trim() : "");
  return {
    openaiKey: clean(process.env.OPENAI_API_KEY || OPENAI_API_KEY.value()),
    vapidPublic: clean(process.env.VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.value()),
    vapidPrivate: clean(process.env.VAPID_PRIVATE_KEY || VAPID_PRIVATE_KEY.value()),
    vapidSubject:
      clean(process.env.VAPID_SUBJECT || VAPID_SUBJECT.value()) ||
      "mailto:you@example.com"
  };
}

let openaiClient = null;
function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  const { openaiKey } = getConfig();
  if (!openaiKey) return null;
  openaiClient = new OpenAI({ apiKey: openaiKey });
  return openaiClient;
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

async function readDoc(collection, docId, fallback) {
  const snap = await db.collection(collection).doc(docId).get();
  if (!snap.exists) return fallback;
  return snap.data();
}

async function writeDoc(collection, docId, data) {
  await db.collection(collection).doc(docId).set(data);
}

async function ensureLog(dateStr) {
  const docRef = db.collection("logs").doc(dateStr);
  const snap = await docRef.get();
  if (snap.exists) return { log: snap.data(), ref: docRef };
  const blank = {
    date: dateStr,
    checkins: {},
    consumed: normalizeSummary({}),
    entries: []
  };
  await docRef.set(blank);
  return { log: blank, ref: docRef };
}

async function getTargets() {
  return readDoc("targets", "default", {
    protein_servings: 3,
    veg_servings: 3,
    carb_servings: 2,
    snack_servings: 1,
    water_ml: 2000
  });
}

async function getSettings() {
  return readDoc("settings", "default", {
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
  const snap = await db.collection("subscriptions").get();
  return snap.docs.map((doc) => {
    const data = doc.data() || {};
    return { id: doc.id, subscription: data.subscription || data };
  });
}

function subscriptionId(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
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

let vapidReady = false;
function ensureVapid() {
  const { vapidPublic, vapidPrivate, vapidSubject } = getConfig();
  if (!vapidPublic || !vapidPrivate) {
    return false;
  }
  if (!vapidReady) {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    vapidReady = true;
  }
  return true;
}

async function sendPushToAll(payload) {
  const subs = await getSubscriptions();
  if (!subs.length) return { sent: 0 };
  const results = await Promise.allSettled(
    subs.map((sub) => webpush.sendNotification(sub.subscription, payload))
  );
  let sent = 0;
  const deletions = [];
  results.forEach((res, idx) => {
    if (res.status === "fulfilled") {
      sent += 1;
      return;
    }
    const status = res.reason?.statusCode;
    if (status === 404 || status === 410) {
      deletions.push(db.collection("subscriptions").doc(subs[idx].id).delete());
    }
  });
  if (deletions.length) await Promise.all(deletions);
  return { sent };
}

async function handleNagCheck() {
  if (!ensureVapid()) return;
  const settings = await getSettings();
  const targets = await getTargets();
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (isWithinQuietHours(nowMinutes, settings.quietHours)) return;

  const today = dateKey(now);
  const { log, ref } = await ensureLog(today);
  const remaining = calcRemaining(targets, log.consumed || {});

  let updated = false;
  for (const slot of settings.meals) {
    const slotStart = timeToMinutes(slot.time);
    const slotEnd = slotStart + slot.windowMinutes;
    if (nowMinutes < slotStart || nowMinutes > slotEnd) continue;
    if (log.checkins && log.checkins[slot.id]) continue;

    const key = `${today}-${slot.id}`;
    const stateRef = db.collection("nag_state").doc(key);
    const stateSnap = await stateRef.get();
    const lastSent = stateSnap.exists ? stateSnap.data()?.lastSent?.toMillis?.() : 0;
    const interval = settings.intervalMinutes || 20;
    if (lastSent && Date.now() - lastSent < interval * 60 * 1000) continue;

    const payload = buildNagPayload(slot, remaining);
    await sendPushToAll(payload);
    await stateRef.set(
      { lastSent: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    updated = true;
  }

  if (updated) {
    await ref.set(log);
  }
}

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
  await writeDoc("settings", "default", settings);
  res.json({ ok: true });
});

app.get("/api/targets", async (req, res) => {
  const targets = await getTargets();
  res.json(targets);
});

app.post("/api/targets", async (req, res) => {
  const targets = req.body || {};
  await writeDoc("targets", "default", targets);
  res.json({ ok: true });
});

app.post("/api/checkin", async (req, res) => {
  const slotId = req.body?.slotId;
  if (!slotId) return res.status(400).json({ error: "slotId required" });
  const date = dateKey();
  const { log, ref } = await ensureLog(date);
  log.checkins = log.checkins || {};
  log.checkins[slotId] = true;
  await ref.set(log);
  res.json({ ok: true });
});

app.post("/api/subscribe", async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    return res.status(400).json({ error: "invalid subscription" });
  }
  const id = subscriptionId(sub.endpoint);
  await db
    .collection("subscriptions")
    .doc(id)
    .set(
      {
        subscription: sub,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  res.json({ ok: true });
});

app.post("/api/unsubscribe", async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    return res.status(400).json({ error: "invalid subscription" });
  }
  const id = subscriptionId(sub.endpoint);
  await db.collection("subscriptions").doc(id).delete();
  res.json({ ok: true });
});

app.post("/api/push-test", async (req, res) => {
  if (!ensureVapid()) return res.status(500).json({ error: "missing VAPID keys" });
  const payload = JSON.stringify({ title: "Meal Coach", body: "Test-Erinnerung", tag: "test" });
  const result = await sendPushToAll(payload);
  res.json({ ok: true, ...result });
});

app.post("/api/nag-check", async (req, res) => {
  await handleNagCheck();
  res.json({ ok: true });
});

app.post("/api/log-meal", async (req, res) => {
  const date = req.body?.date || dateKey();
  const summary = normalizeSummary(req.body?.summary || {});
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const { log, ref } = await ensureLog(date);
  log.consumed = normalizeSummary({
    protein_servings: (log.consumed?.protein_servings || 0) + summary.protein_servings,
    veg_servings: (log.consumed?.veg_servings || 0) + summary.veg_servings,
    carb_servings: (log.consumed?.carb_servings || 0) + summary.carb_servings,
    snack_servings: (log.consumed?.snack_servings || 0) + summary.snack_servings,
    water_ml: (log.consumed?.water_ml || 0) + summary.water_ml
  });
  log.entries = log.entries || [];
  log.entries.push({ at: new Date().toISOString(), items, summary });
  await ref.set(log);
  const targets = await getTargets();
  res.json({
    ok: true,
    consumed: log.consumed,
    remaining: calcRemaining(targets, log.consumed)
  });
});

const maybeMultipart = (req, res, next) => {
  if (req.is("multipart/form-data")) {
    upload.single("image")(req, res, next);
    return;
  }
  next();
};

app.post("/api/analyze-meal", maybeMultipart, async (req, res) => {
  const client = getOpenAIClient();
  if (!client) {
    return res.status(500).json({ error: "OPENAI_API_KEY missing" });
  }
  let base64 = "";
  let mimeType = "";
  if (req.file) {
    base64 = req.file.buffer.toString("base64");
    mimeType = req.file.mimetype;
  } else if (req.body?.imageBase64) {
    const raw = String(req.body.imageBase64);
    const cleaned = raw.includes(",") ? raw.split(",").pop() : raw;
    base64 = cleaned || "";
    mimeType = req.body.mimeType || "image/jpeg";
  }
  if (!base64) return res.status(400).json({ error: "image required" });

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
    const imageUrl = `data:${mimeType};base64,${base64}`;

    const response = await client.responses.create({
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
      text: {
        format: { type: "json_schema", name: "meal_analysis", json_schema: schema }
      }
    });

    const text = response.output_text;
    const parsed = JSON.parse(text);
    const summary = normalizeSummary(parsed.summary || {});

    const date = dateKey();
    const { log, ref } = await ensureLog(date);
    log.consumed = normalizeSummary({
      protein_servings: (log.consumed?.protein_servings || 0) + summary.protein_servings,
      veg_servings: (log.consumed?.veg_servings || 0) + summary.veg_servings,
      carb_servings: (log.consumed?.carb_servings || 0) + summary.carb_servings,
      snack_servings: (log.consumed?.snack_servings || 0) + summary.snack_servings,
      water_ml: (log.consumed?.water_ml || 0) + summary.water_ml
    });
    log.entries = log.entries || [];
    log.entries.push({ at: new Date().toISOString(), items: parsed.items, summary });
    await ref.set(log);

    const targets = await getTargets();
    res.json({
      ok: true,
      analysis: parsed,
      consumed: log.consumed,
      remaining: calcRemaining(targets, log.consumed)
    });
  } catch (err) {
    console.error("analyze-meal failed", err?.message || err);
    res.status(500).json({ error: "analysis_failed", detail: err?.message || "unknown" });
  }
});

exports.api = onRequest(
  {
    secrets: [OPENAI_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT]
  },
  app
);
