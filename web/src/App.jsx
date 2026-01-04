import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost, getApiUrl, setApiUrl } from "./api.js";

const CATEGORY_LABELS = {
  protein: "Protein",
  carb: "Kohlenhydrate",
  veg: "Gemuese",
  fat: "Fett",
  snack: "Snack",
  drink: "Getraenk"
};

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map((v) => Number(v));
  return h * 60 + m;
}

function isWithinQuietHours(nowMinutes, quiet) {
  const start = timeToMinutes(quiet.start);
  const end = timeToMinutes(quiet.end);
  if (start === end) return false;
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function formatNumber(value) {
  return Number(value || 0).toFixed(1).replace(/\.0$/, "");
}

function permissionLabel(value) {
  if (value === "granted") return "Erlaubt";
  if (value === "denied") return "Blockiert";
  if (value === "default") return "Nicht entschieden";
  return "Nicht unterstuetzt";
}

function hasManualInput(values) {
  return Object.values(values).some((val) => Number(val) > 0);
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [targets, setTargets] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notifState, setNotifState] = useState("unknown");
  const [localNag, setLocalNag] = useState(true);
  const [apiUrl, setApiUrlState] = useState(getApiUrl());
  const [apiInput, setApiInput] = useState(getApiUrl());
  const [serverReachable, setServerReachable] = useState(true);
  const [manualLog, setManualLog] = useState({
    protein_servings: 0,
    veg_servings: 0,
    carb_servings: 0,
    snack_servings: 0,
    water_ml: 0
  });
  const nagStateRef = useRef({});

  useEffect(() => {
    const perm = "Notification" in window ? Notification.permission : "unsupported";
    setNotifState(perm);
  }, []);

  async function loadData() {
    try {
      const [statusRes, settingsRes] = await Promise.all([
        apiGet("/api/status"),
        apiGet("/api/settings")
      ]);
      setStatus(statusRes);
      setSettings(settingsRes);
      setTargets(statusRes.targets || null);
      setServerReachable(true);
      setError("");
    } catch (err) {
      setError("Server nicht erreichbar. Bitte spaeter erneut versuchen.");
      setServerReachable(false);
    }
  }

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!localNag || !status || !settings) return;
    const timer = setInterval(() => {
      const perm = "Notification" in window ? Notification.permission : "denied";
      if (perm !== "granted") return;
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      if (isWithinQuietHours(nowMinutes, settings.quietHours)) return;

      settings.meals.forEach((slot) => {
        const slotStart = timeToMinutes(slot.time);
        const slotEnd = slotStart + slot.windowMinutes;
        if (nowMinutes < slotStart || nowMinutes > slotEnd) return;
        if (status.checkins && status.checkins[slot.id]) return;

        const key = `${status.date}-${slot.id}`;
        const lastSent = nagStateRef.current[key] || 0;
        if (Date.now() - lastSent < settings.intervalMinutes * 60 * 1000) return;

        new Notification(`Check-in: ${slot.label}`, {
          body: `Bitte oeffnen und bestaetigen. Offen: P ${status.remaining.protein_servings}, G ${status.remaining.veg_servings}`,
          tag: `local-${slot.id}`
        });
        nagStateRef.current[key] = Date.now();
      });
    }, 60 * 1000);
    return () => clearInterval(timer);
  }, [localNag, settings, status]);

  async function requestPermission() {
    if (!("Notification" in window)) {
      setError("Benachrichtigungen werden von diesem Browser nicht unterstuetzt.");
      return;
    }
    const perm = await Notification.requestPermission();
    setNotifState(perm);
  }

  async function subscribePush() {
    setBusy(true);
    setError("");
    try {
      const perm = await Notification.requestPermission();
      setNotifState(perm);
      if (perm !== "granted") throw new Error("permission denied");
      const reg = await navigator.serviceWorker.ready;
      const key = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!key) throw new Error("missing VAPID key");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key)
      });
      await apiPost("/api/subscribe", sub);
    } catch (err) {
      setError("Push-Aktivierung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTestPush() {
    setBusy(true);
    setError("");
    try {
      await apiPost("/api/push-test", {});
    } catch (err) {
      setError("Push-Test fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckin(slotId) {
    setBusy(true);
    setError("");
    try {
      await apiPost("/api/checkin", { slotId });
      await loadData();
    } catch (err) {
      setError("Check-in fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAnalyze(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("read_failed"));
        reader.readAsDataURL(file);
      });
      if (typeof dataUrl !== "string") throw new Error("read_failed");
      const [, base64] = dataUrl.split(",");
      const res = await apiPost("/api/analyze-meal", {
        imageBase64: base64 || "",
        mimeType: file.type || "image/jpeg"
      });
      setAnalysis(res);
      await loadData();
    } catch (err) {
      setError("Bildanalyse fehlgeschlagen.");
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  async function handleManualLog() {
    if (!hasManualInput(manualLog)) return;
    setBusy(true);
    setError("");
    try {
      await apiPost("/api/log-meal", { summary: manualLog, items: [] });
      setManualLog({
        protein_servings: 0,
        veg_servings: 0,
        carb_servings: 0,
        snack_servings: 0,
        water_ml: 0
      });
      await loadData();
    } catch (err) {
      setError("Manueller Eintrag fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    if (!settings) return;
    setBusy(true);
    setError("");
    try {
      await apiPost("/api/settings", settings);
    } catch (err) {
      setError("Speichern fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTargets() {
    if (!targets) return;
    setBusy(true);
    setError("");
    try {
      await apiPost("/api/targets", targets);
      await loadData();
    } catch (err) {
      setError("Ziele speichern fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  function saveApiUrl() {
    const cleaned = apiInput.trim();
    setApiUrl(cleaned);
    const current = getApiUrl();
    setApiUrlState(current);
    setApiInput(current);
    loadData();
  }

  function resetApiUrl() {
    setApiUrl("");
    const current = getApiUrl();
    setApiUrlState(current);
    setApiInput(current);
    loadData();
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Meal Coach</p>
          <h1>Konstante Erinnerungen. Null Ausreden.</h1>
          <p className="sub">
            Struktur durch Check-ins, Foto-Log und klare Tagesziele.
          </p>
        </div>
        <div className="hero-card">
          <p className="label">Server</p>
          <p className="value">{apiUrl}</p>
          <label className="hero-label" htmlFor="api-url">
            Server-URL
          </label>
          <input
            id="api-url"
            className="hero-input"
            type="text"
            value={apiInput}
            onChange={(e) => setApiInput(e.target.value)}
            placeholder="https://dein-backend.example"
          />
          <span className={`pill ${serverReachable ? "ok" : "warn"}`}>
            {serverReachable ? "Verbunden" : "Offline"}
          </span>
          <div className="actions">
            <button onClick={saveApiUrl} disabled={busy}>
              Speichern
            </button>
            <button className="ghost" onClick={resetApiUrl} disabled={busy}>
              Zuruecksetzen
            </button>
            <button className="ghost" onClick={loadData} disabled={busy}>
              Aktualisieren
            </button>
          </div>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <section className="panel">
        <div className="panel-header">
          <h2>Schnellstart</h2>
          <span className="pill">In 3 Schritten</span>
        </div>
        <div className="guide">
          <div>
            <h3>1. Benachrichtigungen erlauben</h3>
            <p className="muted">Ohne Freigabe gibt es keine Erinnerungen.</p>
          </div>
          <div>
            <h3>2. Push aktivieren</h3>
            <p className="muted">So bekommst du Hinweise auch im Hintergrund.</p>
          </div>
          <div>
            <h3>3. Check-ins setzen</h3>
            <p className="muted">Nach jeder Mahlzeit abhaken und entspannen.</p>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Tagesuebersicht</h2>
          {status ? <span className="pill">{status.date}</span> : null}
        </div>
        <div className="grid">
          <div className="metric">
            <p>Protein</p>
            <h3>{formatNumber(status?.remaining?.protein_servings)}</h3>
            <span>Noch offen</span>
          </div>
          <div className="metric">
            <p>Gemuese</p>
            <h3>{formatNumber(status?.remaining?.veg_servings)}</h3>
            <span>Noch offen</span>
          </div>
          <div className="metric">
            <p>Kohlenhydrate</p>
            <h3>{formatNumber(status?.remaining?.carb_servings)}</h3>
            <span>Noch offen</span>
          </div>
          <div className="metric">
            <p>Wasser</p>
            <h3>{Math.round(status?.remaining?.water_ml || 0)}</h3>
            <span>ml offen</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Mahlzeiten-Check-ins</h2>
          <span className="pill">Antippen zum Abhaken</span>
        </div>
        <div className="checkins">
          {settings?.meals?.map((slot) => (
            <button
              key={slot.id}
              className={`checkin ${status?.checkins?.[slot.id] ? "done" : ""}`}
              onClick={() => handleCheckin(slot.id)}
              disabled={busy}
            >
              <span>{slot.label}</span>
              <span>{slot.time}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Erinnerungen</h2>
          <span className="pill">So nervig wie noetig</span>
        </div>
        <div className="grid-two">
          <div className="card">
            <p className="label">Benachrichtigungen</p>
            <p className="value">{permissionLabel(notifState)}</p>
            <div className="actions">
              <button onClick={requestPermission} disabled={busy}>
                Benachrichtigungen erlauben
              </button>
              <button className="ghost" onClick={() => setLocalNag(!localNag)}>
                Lokaler Alarm: {localNag ? "An" : "Aus"}
              </button>
            </div>
          </div>
          <div className="card">
            <p className="label">Push</p>
            <p className="value">Erinnerungen im Hintergrund</p>
            <div className="actions">
              <button onClick={subscribePush} disabled={busy}>
                Push aktivieren
              </button>
              <button className="ghost" onClick={sendTestPush} disabled={busy}>
                Push testen
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Foto-Log</h2>
          <span className="pill">KI-Analyse</span>
        </div>
        <div className="photo">
          <input type="file" accept="image/*" onChange={handleAnalyze} disabled={busy} />
          {analysis?.analysis ? (
            <div className="analysis">
              <h3>KI-Ergebnis</h3>
              <p>{analysis.analysis.note}</p>
              <ul>
                {analysis.analysis.items.map((item, idx) => (
                  <li key={`${item.name}-${idx}`}>
                    {item.name} - {CATEGORY_LABELS[item.category] || item.category} - {item.estimated_amount} ({item.servings})
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted">Foto hochladen, um Portionen zu schaetzen.</p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Manuell nachtragen</h2>
          <span className="pill">Schnell-Log</span>
        </div>
        <div className="settings">
          <label>
            Protein (Portionen)
            <input
              type="number"
              step="0.5"
              min="0"
              value={manualLog.protein_servings}
              onChange={(e) =>
                setManualLog({ ...manualLog, protein_servings: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Gemuese (Portionen)
            <input
              type="number"
              step="0.5"
              min="0"
              value={manualLog.veg_servings}
              onChange={(e) =>
                setManualLog({ ...manualLog, veg_servings: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Kohlenhydrate (Portionen)
            <input
              type="number"
              step="0.5"
              min="0"
              value={manualLog.carb_servings}
              onChange={(e) =>
                setManualLog({ ...manualLog, carb_servings: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Snacks (Portionen)
            <input
              type="number"
              step="0.5"
              min="0"
              value={manualLog.snack_servings}
              onChange={(e) =>
                setManualLog({ ...manualLog, snack_servings: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Wasser (ml)
            <input
              type="number"
              step="100"
              min="0"
              value={manualLog.water_ml}
              onChange={(e) => setManualLog({ ...manualLog, water_ml: Number(e.target.value) })}
            />
          </label>
          <button onClick={handleManualLog} disabled={busy || !hasManualInput(manualLog)}>
            Eintrag speichern
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Tagesziele</h2>
          <span className="pill">Anpassen</span>
        </div>
        {targets ? (
          <div className="settings">
            <label>
              Protein (Portionen)
              <input
                type="number"
                step="0.5"
                min="0"
                value={targets.protein_servings}
                onChange={(e) =>
                  setTargets({ ...targets, protein_servings: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Gemuese (Portionen)
              <input
                type="number"
                step="0.5"
                min="0"
                value={targets.veg_servings}
                onChange={(e) => setTargets({ ...targets, veg_servings: Number(e.target.value) })}
              />
            </label>
            <label>
              Kohlenhydrate (Portionen)
              <input
                type="number"
                step="0.5"
                min="0"
                value={targets.carb_servings}
                onChange={(e) =>
                  setTargets({ ...targets, carb_servings: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Snacks (Portionen)
              <input
                type="number"
                step="0.5"
                min="0"
                value={targets.snack_servings}
                onChange={(e) =>
                  setTargets({ ...targets, snack_servings: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Wasser (ml)
              <input
                type="number"
                step="100"
                min="0"
                value={targets.water_ml}
                onChange={(e) => setTargets({ ...targets, water_ml: Number(e.target.value) })}
              />
            </label>
            <button onClick={saveTargets} disabled={busy}>
              Ziele speichern
            </button>
          </div>
        ) : (
          <p className="muted">Ziele werden geladen...</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Leitlinien</h2>
          <span className="pill">Alltagstauglich</span>
        </div>
        <ul className="plan-list">
          <li>Regelmaessigkeit vor Perfektion: 3 feste Mahlzeiten pro Tag.</li>
          <li>Jede Mahlzeit: Protein + etwas Frisches (Gemuese oder Obst).</li>
          <li>Snack bewusst einsetzen, nicht aus Stress oder Gewohnheit.</li>
          <li>Tagsueber versorgen, abends leichter essen.</li>
          <li>Wasser beibehalten, Alkohol nicht mit Snacks koppeln.</li>
        </ul>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Zeitplan</h2>
          <span className="pill">Editierbar</span>
        </div>
        {settings ? (
          <div className="settings">
            <label>
              Erinnerungs-Intervall (Minuten)
              <input
                type="number"
                min="5"
                value={settings.intervalMinutes}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    intervalMinutes: Number(e.target.value)
                  })
                }
              />
            </label>
            <label>
              Ruhezeit Start
              <input
                type="time"
                value={settings.quietHours.start}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    quietHours: { ...settings.quietHours, start: e.target.value }
                  })
                }
              />
            </label>
            <label>
              Ruhezeit Ende
              <input
                type="time"
                value={settings.quietHours.end}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    quietHours: { ...settings.quietHours, end: e.target.value }
                  })
                }
              />
            </label>
            <div className="meal-settings">
              {settings.meals.map((slot, idx) => (
                <div key={slot.id} className="meal-row">
                  <strong>{slot.label}</strong>
                  <input
                    type="time"
                    value={slot.time}
                    onChange={(e) => {
                      const next = [...settings.meals];
                      next[idx] = { ...slot, time: e.target.value };
                      setSettings({ ...settings, meals: next });
                    }}
                  />
                  <input
                    type="number"
                    min="30"
                    value={slot.windowMinutes}
                    onChange={(e) => {
                      const next = [...settings.meals];
                      next[idx] = { ...slot, windowMinutes: Number(e.target.value) };
                      setSettings({ ...settings, meals: next });
                    }}
                  />
                </div>
              ))}
            </div>
            <button onClick={saveSettings} disabled={busy}>
              Zeitplan speichern
            </button>
          </div>
        ) : (
          <p className="muted">Zeitplan wird geladen...</p>
        )}
      </section>
    </div>
  );
}
