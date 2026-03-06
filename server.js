/**
 * HealthSetu NER — Backend Sync Server
 * Stack: Express + SQLite (better-sqlite3)
 *
 * Setup:
 *   npm init -y
 *   npm install express better-sqlite3 cors
 *   node server.js
 *
 * Deploy to Railway (free):
 *   1. Push this file to a GitHub repo
 *   2. Go to railway.app → New Project → Deploy from GitHub
 *   3. Done. Copy the URL into API_BASE in your React app.
 */

const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, "healthsetu.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS patients (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    age         INTEGER,
    gender      TEXT,
    village     TEXT,
    phone       TEXT,
    condition   TEXT,
    weight      REAL,
    bp          TEXT,
    temp        REAL,
    last_visit  TEXT,
    pregnancy_week INTEGER,
    vaccinations TEXT,   -- JSON array stored as string
    vitals_history TEXT, -- JSON array stored as string
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id TEXT,
    synced_at  TEXT DEFAULT (datetime('now')),
    source_ip  TEXT
  );
`);

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "HealthSetu NER", time: new Date().toISOString() });
});

// Sync endpoint — receives pending patients from ASHA device
app.post("/api/sync", (req, res) => {
  const { patients } = req.body;

  if (!Array.isArray(patients) || patients.length === 0) {
    return res.status(400).json({ error: "No patients provided" });
  }

  const upsert = db.prepare(`
    INSERT INTO patients (id, name, age, gender, village, phone, condition, weight, bp, temp,
      last_visit, pregnancy_week, vaccinations, vitals_history, updated_at)
    VALUES (@id, @name, @age, @gender, @village, @phone, @condition, @weight, @bp, @temp,
      @last_visit, @pregnancy_week, @vaccinations, @vitals_history, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, age=excluded.age, weight=excluded.weight,
      bp=excluded.bp, temp=excluded.temp, last_visit=excluded.last_visit,
      pregnancy_week=excluded.pregnancy_week, vaccinations=excluded.vaccinations,
      vitals_history=excluded.vitals_history, updated_at=excluded.updated_at
  `);

  const logSync = db.prepare(
    "INSERT INTO sync_log (patient_id, source_ip) VALUES (?, ?)"
  );

  const syncMany = db.transaction((pts) => {
    for (const p of pts) {
      upsert.run({
        id: p.id,
        name: p.name,
        age: p.age,
        gender: p.gender,
        village: p.village,
        phone: p.phone || "",
        condition: p.condition,
        weight: p.weight,
        bp: p.bp,
        temp: p.temp,
        last_visit: p.lastVisit,
        pregnancy_week: p.pregnancyWeek || null,
        vaccinations: JSON.stringify(p.vaccinations || []),
        vitals_history: JSON.stringify(p.vitalsHistory || []),
      });
      logSync.run(p.id, req.ip);
    }
  });

  try {
    syncMany(patients);
    console.log(`[SYNC] ${patients.length} patients from ${req.ip} at ${new Date().toISOString()}`);
    res.json({ success: true, synced: patients.length });
  } catch (err) {
    console.error("[SYNC ERROR]", err);
    res.status(500).json({ error: "Database error", detail: err.message });
  }
});

// Get all patients (supervisor dashboard)
app.get("/api/patients", (req, res) => {
  const { village, condition } = req.query;
  let query = "SELECT * FROM patients";
  const params = [];

  const filters = [];
  if (village) { filters.push("village = ?"); params.push(village); }
  if (condition) { filters.push("condition = ?"); params.push(condition); }
  if (filters.length) query += " WHERE " + filters.join(" AND ");
  query += " ORDER BY updated_at DESC";

  const rows = db.prepare(query).all(...params);
  const patients = rows.map(r => ({
    ...r,
    vaccinations: JSON.parse(r.vaccinations || "[]"),
    vitalsHistory: JSON.parse(r.vitals_history || "[]"),
  }));
  res.json({ patients, total: patients.length });
});

// Aggregate stats by village (supervisor map view)
app.get("/api/stats/villages", (req, res) => {
  const rows = db.prepare(`
    SELECT
      village,
      COUNT(*) AS total,
      SUM(CASE WHEN condition='Pregnancy' THEN 1 ELSE 0 END) AS pregnancies,
      SUM(CASE WHEN condition='Hypertension' THEN 1 ELSE 0 END) AS hypertension,
      SUM(CASE WHEN condition='Diabetes' THEN 1 ELSE 0 END) AS diabetes
    FROM patients
    GROUP BY village
    ORDER BY total DESC
  `).all();
  res.json({ villages: rows });
});

// Recent sync log
app.get("/api/sync/log", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 50"
  ).all();
  res.json({ log: rows });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ HealthSetu server running on http://localhost:${PORT}`);
  console.log(`   POST /api/sync       — receive patient data from ASHAs`);
  console.log(`   GET  /api/patients   — list all synced patients`);
  console.log(`   GET  /api/stats/villages — aggregated village stats\n`);
});
