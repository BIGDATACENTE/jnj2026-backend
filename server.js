// ============================================================
// JNJ 2026 — Backend centralisé (Express + SQLite + SSE)
// ============================================================
// Remplace le stockage localStorage/sessionStorage du frontend
// par une base de données centralisée partagée entre tous les
// appareils, avec diffusion temps réel via Server-Sent Events.
// ============================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'jnj2026.db');
const MAX_BODY_SIZE = '15mb'; // photos/signatures en base64 peuvent être volumineuses

// ------------------------------------------------------------
// 1. BASE DE DONNÉES
// ------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    day TEXT NOT NULL,
    ts TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_unique ON visits(visitor_id, day);

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    role TEXT NOT NULL,
    nom TEXT,
    diocese TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

// Default shape of the application state (mirrors the old getDB() default
// from the frontend so existing rendering code keeps working unchanged).
const DEFAULT_STATE = {
  codes: [], ins: [], logs: [], users: [], dioceses: [], chat: [], notifs: {},
  preins: [], wall: [], galerie: [], lostfound: [], priere: {}, live: { active: false },
  visits: []
};

function loadState() {
  const row = db.prepare('SELECT data, version FROM app_state WHERE id = 1').get();
  if (!row) {
    const initial = JSON.stringify(DEFAULT_STATE);
    db.prepare('INSERT INTO app_state (id, data, version, updated_at) VALUES (1, ?, 1, ?)')
      .run(initial, new Date().toISOString());
    return { data: JSON.parse(initial), version: 1 };
  }
  const data = JSON.parse(row.data);
  // Ensure newer fields exist on older saved states (same logic as the old getDB())
  Object.keys(DEFAULT_STATE).forEach((k) => {
    if (data[k] === undefined) data[k] = DEFAULT_STATE[k];
  });
  return { data, version: row.version };
}

function saveState(newData, expectedVersion) {
  // Ensure the row exists (first-run case) before comparing versions.
  let current = db.prepare('SELECT version FROM app_state WHERE id = 1').get();
  if (!current) {
    db.prepare('INSERT INTO app_state (id, data, version, updated_at) VALUES (1, ?, 1, ?)')
      .run(JSON.stringify(DEFAULT_STATE), new Date().toISOString());
    current = { version: 1 };
  }
  const currentVersion = current.version;

  // Optimistic concurrency: if expectedVersion is provided and doesn't match,
  // reject so the client can reload and retry instead of silently
  // overwriting another device's concurrent change.
  if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== currentVersion) {
    return { ok: false, conflict: true, version: currentVersion };
  }

  const nextVersion = currentVersion + 1;
  const json = JSON.stringify(newData);
  db.prepare(`
    INSERT INTO app_state (id, data, version, updated_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at
  `).run(json, nextVersion, new Date().toISOString());

  return { ok: true, version: nextVersion };
}

// ------------------------------------------------------------
// 2. SESSIONS (auth simple par token)
// ------------------------------------------------------------
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// Built-in accounts (same credentials as the previous client-side USERS_DB).
// In production, change these passwords and/or move them to environment
// variables before going live.
const BUILTIN_USERS = {
  hyperviseur: { pass: process.env.PASS_HYPERVISEUR || 'bigdata2026', role: 'hyperviseur', nom: 'Admin Général', diocese: 'Tous' },
  superviseur: { pass: process.env.PASS_SUPERVISEUR || 'aumdioc2026', role: 'superviseur', nom: 'Aumônier Diocésain', diocese: 'Archidiocèse de Douala' },
  admin: { pass: process.env.PASS_ADMIN || 'jnj2026', role: 'admin', nom: 'Aumônier de Zone', diocese: 'Archidiocèse de Douala' },
  gestionnaire: { pass: process.env.PASS_GESTIONNAIRE || 'gest2026', role: 'gestionnaire', nom: 'Aumônier de Paroisse', diocese: 'Archidiocèse de Douala' },
  utilisateur: { pass: process.env.PASS_UTILISATEUR || 'user2026', role: 'utilisateur', nom: 'Utilisateur Standard', diocese: 'Archidiocèse de Douala' },
};

function createSession(login, info) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare('INSERT INTO sessions (token, login, role, nom, diocese, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(token, login, info.role, info.nom || '', info.diocese || '', now.toISOString(), expires.toISOString());
  return { token, expires: expires.toISOString() };
}

function getSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}
setInterval(cleanupSessions, 60 * 60 * 1000);

// ------------------------------------------------------------
// 3. SSE (diffusion temps réel)
// ------------------------------------------------------------
const sseClients = new Set();

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

// Heartbeat to keep connections alive through proxies/load balancers
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25000);

// ------------------------------------------------------------
// 4. APP
// ------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: MAX_BODY_SIZE }));

// Basic IP-based rate limiting for write endpoints (anti-spam, no extra deps)
const rateMap = new Map(); // ip -> { count, windowStart }
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60; // max écritures / minute / IP

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }
  entry.count++;
  rateMap.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Trop de requêtes, veuillez patienter.' });
  }
  next();
}

// ------------------------------------------------------------
// 5. ROUTES — État applicatif (remplace getDB/saveDB)
// ------------------------------------------------------------

// GET /api/db — récupère l'état complet + numéro de version
app.get('/api/db', (req, res) => {
  const { data, version } = loadState();
  res.json({ data, version });
});

// POST /api/db — enregistre l'état complet (avec contrôle de version optimiste)
// body: { data: {...}, version: <int attendu> }
app.post('/api/db', rateLimit, (req, res) => {
  const { data, version } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Corps de requête invalide : champ "data" manquant.' });
  }

  const result = saveState(data, version);
  if (!result.ok) {
    return res.status(409).json({
      error: 'Conflit de version : des modifications plus récentes existent. Rechargez les données.',
      version: result.version
    });
  }

  broadcast('db-updated', { version: result.version, by: req.body.clientId || null });
  res.json({ ok: true, version: result.version });
});

// GET /api/events — flux SSE de mise à jour temps réel
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ------------------------------------------------------------
// 6. ROUTES — Visiteurs (compteurs centralisés et précis)
// ------------------------------------------------------------

// POST /api/visits/ping — enregistre une visite unique par jour et par visiteur
// body: { visitorId: "<identifiant stable côté client>" }
app.post('/api/visits/ping', rateLimit, (req, res) => {
  const visitorId = (req.body && req.body.visitorId) || req.ip || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const ts = new Date().toISOString();

  try {
    db.prepare('INSERT INTO visits (visitor_id, day, ts) VALUES (?,?,?)').run(visitorId, day, ts);
  } catch (e) {
    // UNIQUE constraint => déjà comptée aujourd'hui, ce n'est pas une erreur
  }

  res.json(getVisitorStats());
});

// GET /api/visits/stats — statistiques de visites (total, jour, semaine, mois)
app.get('/api/visits/stats', (req, res) => {
  res.json(getVisitorStats());
});

function getVisitorStats() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const startOfWeek = new Date(now);
  const dow = (startOfWeek.getDay() + 6) % 7; // lundi = 0
  startOfWeek.setDate(startOfWeek.getDate() - dow);
  const weekStr = startOfWeek.toISOString().slice(0, 10);

  const monthStr = today.slice(0, 7); // YYYY-MM

  const total = db.prepare('SELECT COUNT(*) AS c FROM visits').get().c;
  const todayCount = db.prepare('SELECT COUNT(*) AS c FROM visits WHERE day = ?').get(today).c;
  const weekCount = db.prepare('SELECT COUNT(*) AS c FROM visits WHERE day >= ?').get(weekStr).c;
  const monthCount = db.prepare("SELECT COUNT(*) AS c FROM visits WHERE substr(day,1,7) = ?").get(monthStr).c;

  return { total, today: todayCount, week: weekCount, month: monthCount };
}

// ------------------------------------------------------------
// 7. ROUTES — Authentification (Espace Gérant)
// ------------------------------------------------------------

// POST /api/login — body: { login, password }
app.post('/api/login', rateLimit, (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
  }

  let userInfo = BUILTIN_USERS[login];

  if (!userInfo) {
    // Dynamic users are stored inside the JSON app state (db.users), exactly
    // as before, so we read them from there.
    const { data } = loadState();
    const dynUser = (data.users || []).find((u) => u.login === login);
    if (dynUser) {
      userInfo = { pass: dynUser.pass, role: dynUser.role, nom: dynUser.nom, diocese: dynUser.diocese };
    }
  }

  if (!userInfo || userInfo.pass !== password) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }

  const session = createSession(login, userInfo);
  res.json({
    ok: true,
    token: session.token,
    expires: session.expires,
    user: { id: login, role: userInfo.role, nom: userInfo.nom, diocese: userInfo.diocese }
  });
});

// POST /api/logout — body: { } — header: Authorization: Bearer <token>
app.post('/api/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

// GET /api/me — vérifie un token de session et renvoie l'utilisateur courant
app.get('/api/me', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Session invalide ou expirée.' });
  res.json({ id: session.login, role: session.role, nom: session.nom, diocese: session.diocese });
});

// ------------------------------------------------------------
// 8. SANTÉ / DIAGNOSTIC
// ------------------------------------------------------------
app.get('/api/health', (req, res) => {
  const { version } = loadState();
  res.json({ ok: true, version, clients: sseClients.size, time: new Date().toISOString() });
});

// ------------------------------------------------------------
// 9. (Optionnel) Servir le frontend statique
// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// START
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`JNJ 2026 backend démarré sur le port ${PORT}`);
  console.log(`Base de données : ${DB_PATH}`);
});
