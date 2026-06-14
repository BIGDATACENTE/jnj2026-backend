// ============================================================
// JNJ 2026 — Migration SQLite -> Supabase PostgreSQL
// ============================================================
// Usage :
//   1. Copiez l'ancien fichier data/jnj2026.db dans ce dossier
//      (ou indiquez son chemin via SQLITE_PATH).
//   2. Définissez la variable d'environnement DATABASE_URL avec
//      la chaîne de connexion Postgres de votre projet Supabase
//      (Project Settings > Database > Connection string > URI,
//      utilisez de préférence le "connection pooler" port 6543
//      pour Render, ou le port 5432 pour une exécution locale).
//   3. Exécutez d'abord migration/schema.sql dans Supabase
//      (SQL Editor) pour créer les tables.
//   4. Lancez :
//        cd jnj2026-backend
//        npm install
//        SQLITE_PATH=./old-data/jnj2026.db DATABASE_URL=postgresql://... \
//          node migration/migrate-sqlite-to-postgres.js
// ============================================================

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'jnj2026.db');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ Variable DATABASE_URL manquante (chaîne de connexion Supabase Postgres).');
  process.exit(1);
}

if (!fs.existsSync(SQLITE_PATH)) {
  console.error(`❌ Fichier SQLite introuvable : ${SQLITE_PATH}`);
  console.error('   Définissez SQLITE_PATH=/chemin/vers/jnj2026.db');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  console.log(`📂 Lecture SQLite : ${SQLITE_PATH}`);
  const db = new DatabaseSync(SQLITE_PATH, { readOnly: true });

  // --------------------------------------------------------
  // 1. app_state (état JSON global)
  // --------------------------------------------------------
  const stateRow = db.prepare('SELECT data, version, updated_at FROM app_state WHERE id = 1').get();
  if (stateRow) {
    console.log(`📦 app_state trouvé (version ${stateRow.version})`);
    const data = JSON.parse(stateRow.data);

    await pool.query(
      `INSERT INTO app_state (id, data, version, updated_at)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             version = EXCLUDED.version,
             updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(data), stateRow.version, stateRow.updated_at]
    );
    console.log('✅ app_state migré (préinscriptions, inscrits, mur, galerie, objets perdus, etc.)');
  } else {
    console.log('⚠️  Aucun app_state trouvé dans la base SQLite — rien à migrer pour l\'état global.');
  }

  // --------------------------------------------------------
  // 2. visits
  // --------------------------------------------------------
  let visitRows = [];
  try {
    visitRows = db.prepare('SELECT visitor_id, day, ts FROM visits').all();
  } catch (e) {
    console.log('⚠️  Table visits absente ou vide.');
  }

  if (visitRows.length) {
    console.log(`📦 ${visitRows.length} visites trouvées, migration...`);
    let migrated = 0;
    for (const row of visitRows) {
      try {
        await pool.query(
          `INSERT INTO visits (visitor_id, day, ts)
           VALUES ($1, $2, $3)
           ON CONFLICT (visitor_id, day) DO NOTHING`,
          [row.visitor_id, row.day, row.ts]
        );
        migrated++;
      } catch (e) {
        console.warn(`   ⚠️ Ligne ignorée (${row.visitor_id}, ${row.day}) :`, e.message);
      }
    }
    console.log(`✅ ${migrated}/${visitRows.length} visites migrées.`);
  } else {
    console.log('ℹ️  Aucune visite à migrer.');
  }

  // --------------------------------------------------------
  // 3. sessions (optionnel — souvent inutile de migrer des
  //    sessions actives, mais inclus par exhaustivité)
  // --------------------------------------------------------
  let sessionRows = [];
  try {
    sessionRows = db.prepare('SELECT token, login, role, nom, diocese, created_at, expires_at FROM sessions').all();
  } catch (e) {
    console.log('⚠️  Table sessions absente ou vide.');
  }

  if (sessionRows.length) {
    console.log(`📦 ${sessionRows.length} sessions trouvées, migration des sessions non expirées...`);
    const now = new Date().toISOString();
    let migrated = 0;
    for (const row of sessionRows) {
      if (row.expires_at < now) continue; // ignore les sessions expirées
      try {
        await pool.query(
          `INSERT INTO sessions (token, login, role, nom, diocese, created_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (token) DO NOTHING`,
          [row.token, row.login, row.role, row.nom, row.diocese, row.created_at, row.expires_at]
        );
        migrated++;
      } catch (e) {
        console.warn(`   ⚠️ Session ignorée (${row.login}) :`, e.message);
      }
    }
    console.log(`✅ ${migrated} sessions actives migrées.`);
  } else {
    console.log('ℹ️  Aucune session à migrer.');
  }

  await pool.end();
  console.log('🎉 Migration terminée avec succès.');
}

main().catch((e) => {
  console.error('❌ Erreur durant la migration :', e);
  process.exit(1);
});
