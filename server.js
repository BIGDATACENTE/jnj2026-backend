// ============================================================
// JNJ 2026 — Backend centralisé (Express + Supabase PostgreSQL + SSE)
// ============================================================
// Remplace SQLite par PostgreSQL (Supabase). Les données survivent
// donc aux redéploiements de Render (la base est hébergée chez
// Supabase, pas sur le disque éphémère de Render).
//
// Architecture inchangée pour le frontend : un état JSON global
// (codes, ins, logs, users, dioceses, chat, notifs, preins, wall,
// galerie, lostfound, priere, live) versionné de façon optimiste,
// + tables dédiées pour les visites et les sessions.
// Diffusion temps réel via Server-Sent Events (/api/events),
// inchangé côté frontend.
// ============================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const MAX_BODY_SIZE = '15mb'; // photos/signatures en base64 peuvent être volumineuses

// ------------------------------------------------------------
// 1. BASE DE DONNÉES (Supabase PostgreSQL)
// ------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ Variable d\'environnement DATABASE_URL manquante (chaîne de connexion Supabase Postgres).');
  process.exit(1);
}

// Supabase requiert SSL. rejectUnauthorized:false permet d'utiliser le
// certificat fourni par Supabase sans configuration CA supplémentaire.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5)
});

const DEFAULT_STATE = {
  codes: [], ins: [], logs: [], users: [], dioceses: [], chat: [], notifs: {},
  preins: [], wall: [], galerie: [], lostfound: [], priere: {}, live: { active: false },
  visits: []
};

async function ensureSchema() {
  // Crée les tables si elles n'existent pas encore (au cas où
  // migration/schema.sql n'a pas été exécuté manuellement).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id integer PRIMARY KEY CHECK (id = 1),
      data jsonb NOT NULL,
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS visits (
      id bigserial PRIMARY KEY,
      visitor_id text NOT NULL,
      day date NOT NULL,
      ts timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_unique ON visits (visitor_id, day);

    CREATE TABLE IF NOT EXISTS sessions (
      token text PRIMARY KEY,
      login text NOT NULL,
      role text NOT NULL,
      nom text,
      diocese text,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );
  `);

  const { rows } = await pool.query('SELECT 1 FROM app_state WHERE id = 1');
  if (rows.length === 0) {
    await pool.query(
      'INSERT INTO app_state (id, data, version, updated_at) VALUES (1, $1, 1, now())',
      [JSON.stringify(DEFAULT_STATE)]
    );
  }
}

async function loadState() {
  const { rows } = await pool.query('SELECT data, version FROM app_state WHERE id = 1');
  if (rows.length === 0) {
    await pool.query(
      'INSERT INTO app_state (id, data, version, updated_at) VALUES (1, $1, 1, now())',
      [JSON.stringify(DEFAULT_STATE)]
    );
    return { data: JSON.parse(JSON.stringify(DEFAULT_STATE)), version: 1 };
  }
  // node-postgres parse automatiquement les colonnes jsonb en objets JS.
  const data = rows[0].data;
  Object.keys(DEFAULT_STATE).forEach((k) => {
    if (data[k] === undefined) data[k] = DEFAULT_STATE[k];
  });
  return { data, version: rows[0].version };
}

async function saveState(newData, expectedVersion) {
  // Transaction pour garantir l'atomicité de la vérification de version
  // + écriture (équivalent du contrôle optimiste de la version SQLite).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query('SELECT version FROM app_state WHERE id = 1 FOR UPDATE');
    let currentVersion;
    if (cur.rows.length === 0) {
      await client.query(
        'INSERT INTO app_state (id, data, version, updated_at) VALUES (1, $1, 1, now())',
        [JSON.stringify(DEFAULT_STATE)]
      );
      currentVersion = 1;
    } else {
      currentVersion = cur.rows[0].version;
    }

    if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== currentVersion) {
      await client.query('ROLLBACK');
      return { ok: false, conflict: true, version: currentVersion };
    }

    const nextVersion = currentVersion + 1;
    await client.query(
      `INSERT INTO app_state (id, data, version, updated_at)
       VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data, version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(newData), nextVersion]
    );

    await client.query('COMMIT');
    return { ok: true, version: nextVersion };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// 2. SESSIONS (auth simple par token)
// ------------------------------------------------------------
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// Comptes intégrés (mêmes identifiants que l'ancien USERS_DB côté client).
// Changez impérativement ces mots de passe via les variables
// d'environnement avant un déploiement national.
const BUILTIN_USERS = {
  hyperviseur: { pass: process.env.PASS_HYPERVISEUR || 'bigdata2026', role: 'hyperviseur', nom: 'Admin Général', diocese: 'Tous' },
  superviseur: { pass: process.env.PASS_SUPERVISEUR || 'aumdioc2026', role: 'superviseur', nom: 'Aumônier Diocésain', diocese: 'Archidiocèse de Douala' },
  admin: { pass: process.env.PASS_ADMIN || 'jnj2026', role: 'admin', nom: 'Aumônier de Zone', diocese: 'Archidiocèse de Douala' },
  gestionnaire: { pass: process.env.PASS_GESTIONNAIRE || 'gest2026', role: 'gestionnaire', nom: 'Aumônier de Paroisse', diocese: 'Archidiocèse de Douala' },
  utilisateur: { pass: process.env.PASS_UTILISATEUR || 'user2026', role: 'utilisateur', nom: 'Utilisateur Standard', diocese: 'Archidiocèse de Douala' },
};

async function createSession(login, info) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  await pool.query(
    'INSERT INTO sessions (token, login, role, nom, diocese, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [token, login, info.role, info.nom || '', info.diocese || '', now.toISOString(), expires.toISOString()]
  );
  return { token, expires: expires.toISOString() };
}

async function getSession(token) {
  if (!token) return null;
  const { rows } = await pool.query('SELECT * FROM sessions WHERE token = $1', [token]);
  if (rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    return null;
  }
  return row;
}

async function cleanupSessions() {
  try {
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  } catch (e) {
    console.error('Erreur nettoyage sessions :', e.message);
  }
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

// Heartbeat pour garder les connexions ouvertes à travers les proxys
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25000);

// ------------------------------------------------------------
// 4. APP
// ------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: MAX_BODY_SIZE }));

// Limitation de débit basique par IP sur les routes d'écriture
const rateMap = new Map();
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

// Petit middleware pour transformer les erreurs Postgres en 500 propres
function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ------------------------------------------------------------
// 5. ROUTES — État applicatif (remplace getDB/saveDB)
// ------------------------------------------------------------

// GET /api/db — récupère l'état complet + numéro de version
app.get('/api/db', asyncHandler(async (req, res) => {
  const { data, version } = await loadState();
  res.json({ data, version });
}));

// POST /api/db — enregistre l'état complet (avec contrôle de version optimiste)
// body: { data: {...}, version: <int attendu> }
app.post('/api/db', rateLimit, asyncHandler(async (req, res) => {
  const { data, version } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Corps de requête invalide : champ "data" manquant.' });
  }

  const result = await saveState(data, version);
  if (!result.ok) {
    return res.status(409).json({
      error: 'Conflit de version : des modifications plus récentes existent. Rechargez les données.',
      version: result.version
    });
  }

  broadcast('db-updated', { version: result.version, by: req.body.clientId || null });
  res.json({ ok: true, version: result.version });
}));

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
app.post('/api/visits/ping', rateLimit, asyncHandler(async (req, res) => {
  const visitorId = (req.body && req.body.visitorId) || req.ip || 'anon';
  const day = new Date().toISOString().slice(0, 10);

  try {
    await pool.query(
      'INSERT INTO visits (visitor_id, day, ts) VALUES ($1,$2,now()) ON CONFLICT (visitor_id, day) DO NOTHING',
      [visitorId, day]
    );
  } catch (e) {
    console.error('Erreur enregistrement visite :', e.message);
  }

  res.json(await getVisitorStats());
}));

// GET /api/visits/stats — statistiques de visites (total, jour, semaine, mois)
app.get('/api/visits/stats', asyncHandler(async (req, res) => {
  res.json(await getVisitorStats());
}));

async function getVisitorStats() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const startOfWeek = new Date(now);
  const dow = (startOfWeek.getDay() + 6) % 7; // lundi = 0
  startOfWeek.setDate(startOfWeek.getDate() - dow);
  const weekStr = startOfWeek.toISOString().slice(0, 10);

  const monthStr = today.slice(0, 7); // YYYY-MM

  const [totalR, todayR, weekR, monthR] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM visits'),
    pool.query('SELECT COUNT(*)::int AS c FROM visits WHERE day = $1', [today]),
    pool.query('SELECT COUNT(*)::int AS c FROM visits WHERE day >= $1', [weekStr]),
    pool.query("SELECT COUNT(*)::int AS c FROM visits WHERE to_char(day,'YYYY-MM') = $1", [monthStr]),
  ]);

  return {
    total: totalR.rows[0].c,
    today: todayR.rows[0].c,
    week: weekR.rows[0].c,
    month: monthR.rows[0].c
  };
}

// ------------------------------------------------------------
// 7. ROUTES — Authentification (Espace Gérant)
// ------------------------------------------------------------

// POST /api/login — body: { login, password }
app.post('/api/login', rateLimit, asyncHandler(async (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
  }

  let userInfo = BUILTIN_USERS[login];

  if (!userInfo) {
    // Utilisateurs dynamiques stockés dans l'état JSON (db.users), comme avant.
    const { data } = await loadState();
    const dynUser = (data.users || []).find((u) => u.login === login);
    if (dynUser) {
      userInfo = { pass: dynUser.pass, role: dynUser.role, nom: dynUser.nom, diocese: dynUser.diocese };
    }
  }

  if (!userInfo || userInfo.pass !== password) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }

  const session = await createSession(login, userInfo);
  res.json({
    ok: true,
    token: session.token,
    expires: session.expires,
    user: { id: login, role: userInfo.role, nom: userInfo.nom, diocese: userInfo.diocese }
  });
}));

// POST /api/logout — body: { } — header: Authorization: Bearer <token>
app.post('/api/logout', asyncHandler(async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ ok: true });
}));

// GET /api/me — vérifie un token de session et renvoie l'utilisateur courant
app.get('/api/me', asyncHandler(async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = await getSession(token);
  if (!session) return res.status(401).json({ error: 'Session invalide ou expirée.' });
  res.json({ id: session.login, role: session.role, nom: session.nom, diocese: session.diocese });
}));

// ------------------------------------------------------------
// 8. SANTÉ / DIAGNOSTIC
// ------------------------------------------------------------
app.get('/api/health', asyncHandler(async (req, res) => {
  const { version } = await loadState();
  res.json({ ok: true, db: 'supabase-postgres', version, clients: sseClients.size, time: new Date().toISOString() });
}));

// ------------------------------------------------------------
// 9. (Optionnel) Servir le frontend statique
// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// Gestionnaire d'erreurs générique
// ------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Erreur serveur :', err);
  res.status(500).json({ error: 'Erreur serveur interne.' });
});

// ------------------------------------------------------------
// START
// ------------------------------------------------------------
ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`JNJ 2026 backend démarré sur le port ${PORT}`);
      console.log('Base de données : Supabase PostgreSQL');
    });
  })
  .catch((e) => {
    console.error('❌ Impossible d\'initialiser le schéma PostgreSQL :', e);
    process.exit(1);
  });
