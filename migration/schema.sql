-- ============================================================
-- JNJ 2026 — Schéma Supabase PostgreSQL
-- ============================================================
-- À exécuter dans Supabase : Project > SQL Editor > New query
-- Conserve la même architecture "état JSON global + version
-- optimiste" que la version SQLite, mais sur PostgreSQL, avec
-- en plus la réplication temps réel native de Supabase
-- (Realtime via WAL/Postgres Changes) qui remplace/complète SSE.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ÉTAT APPLICATIF GLOBAL
-- ------------------------------------------------------------
-- Contient tout : codes, ins, logs, users, dioceses, chat, notifs,
-- preins, wall, galerie, lostfound, priere, live, etc.
-- (préinscriptions, inscriptions, publications, objets perdus,
-- galerie photos, statistiques internes restent dans ce blob,
-- comme avant — seules les visites et sessions ont des tables
-- dédiées pour les requêtes statistiques).
CREATE TABLE IF NOT EXISTS app_state (
  id          integer PRIMARY KEY CHECK (id = 1),
  data        jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_state (id, data, version, updated_at)
VALUES (
  1,
  '{
    "codes": [], "ins": [], "logs": [], "users": [], "dioceses": [],
    "chat": [], "notifs": {}, "preins": [], "wall": [], "galerie": [],
    "lostfound": [], "priere": {}, "live": {"active": false}, "visits": []
  }'::jsonb,
  1,
  now()
)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- 2. VISITEURS (compteur centralisé, 1 ligne / visiteur / jour)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visits (
  id          bigserial PRIMARY KEY,
  visitor_id  text NOT NULL,
  day         date NOT NULL,
  ts          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_unique
  ON visits (visitor_id, day);

CREATE INDEX IF NOT EXISTS idx_visits_day ON visits (day);

-- ------------------------------------------------------------
-- 3. SESSIONS (authentification "Espace Gérant")
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  login       text NOT NULL,
  role        text NOT NULL,
  nom         text,
  diocese     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- ------------------------------------------------------------
-- 4. FONCTION + TRIGGER : notifier les changements en temps réel
-- ------------------------------------------------------------
-- Permet à Supabase Realtime (Postgres Changes) de notifier tous
-- les clients abonnés à app_state dès qu'une écriture est faite,
-- en complément (ou remplacement) du flux SSE du backend Express.
-- Activez la réplication pour cette table (voir guide ci-dessous).

-- Active la publication Realtime sur la table app_state
-- (équivalent à cocher la table dans Database > Replication)
ALTER TABLE app_state REPLICA IDENTITY FULL;

-- La commande suivante peut échouer si la publication existe déjà
-- avec d'autres tables : dans ce cas, ajoutez la table via l'UI
-- Supabase (Database > Replication > supabase_realtime > app_state).
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE app_state;
  EXCEPTION WHEN duplicate_object THEN
    NULL; -- déjà ajoutée, on ignore
  END;
END $$;

-- ------------------------------------------------------------
-- 5. NETTOYAGE AUTOMATIQUE DES SESSIONS EXPIRÉES (optionnel)
-- ------------------------------------------------------------
-- Le backend nettoie déjà les sessions expirées périodiquement,
-- mais cette fonction peut être appelée via un cron Supabase
-- (Database > Cron Jobs) si vous préférez le faire côté base.
CREATE OR REPLACE FUNCTION cleanup_expired_sessions()
RETURNS void AS $$
BEGIN
  DELETE FROM sessions WHERE expires_at < now();
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FIN DU SCHÉMA
-- ============================================================
