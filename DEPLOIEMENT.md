# JNJ 2026 — Migration SQLite → Supabase PostgreSQL
## Guide de déploiement (Render + Supabase)

## 1. Ce qui change

| Avant | Après |
|---|---|
| Stockage : SQLite (`node:sqlite`, fichier `data/jnj2026.db`) | Stockage : **Supabase PostgreSQL** (cloud, managé) |
| Persistance : disque Render (perdu sans disque persistant payant) | Persistance : **base Supabase**, indépendante de Render → **survit aux redéploiements/redémarrages** |
| API REST + SSE | **Identiques** : `/api/db`, `/api/visits/*`, `/api/login`, `/api/logout`, `/api/me`, `/api/events`, `/api/health` |
| Architecture des données | **Identique** : un état JSON global versionné (`app_state`, jsonb) + tables `visits` et `sessions` |
| Frontend | **Aucun changement fonctionnel** — même `getDB()`/`saveDB()`, même contrat API. SSE rendu plus robuste (reconnexion avec backoff + polling de secours) |

Toutes les fonctionnalités (préinscriptions, inscriptions, visiteurs,
publications/mur collaboratif, objets perdus/retrouvés, galerie photos,
statistiques) restent dans le même état JSON `app_state.data`, désormais
stocké en colonne `jsonb` PostgreSQL — donc requêtable, indexable, et
sauvegardé automatiquement par Supabase.

---

## 2. Créer le projet Supabase

1. Allez sur [supabase.com](https://supabase.com) → **New project**.
2. Choisissez une région proche de vos utilisateurs (ex: Europe si vos
   visiteurs sont au Cameroun, la latence reste très correcte).
3. Notez le **mot de passe de la base** choisi à la création (vous en
   aurez besoin pour `DATABASE_URL`).
4. Une fois le projet créé, allez dans **SQL Editor** → **New query**,
   collez le contenu de `jnj2026-backend/migration/schema.sql` et
   exécutez-le. Cela crée :
   - `app_state` (état global JSON, avec une ligne initiale)
   - `visits` (compteur de visites uniques par jour)
   - `sessions` (sessions de connexion Espace Gérant)
   - active la réplication temps réel sur `app_state`

5. Récupérez la **chaîne de connexion** : **Project Settings → Database
   → Connection string → URI**. Pour Render (connexions sortantes
   limitées), utilisez de préférence le **Connection Pooler** (mode
   *Transaction*, port `6543`) plutôt que la connexion directe (port
   `5432`). Exemple de format :

   ```
   postgresql://postgres.xxxxxxxx:VOTRE_MOT_DE_PASSE@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
   ```

---

## 3. Migrer les données existantes (si vous avez déjà des données en SQLite)

Si le backend SQLite tourne déjà en production et contient des données
réelles (préinscriptions, inscrits, etc.), migrez-les avant de basculer :

1. Récupérez le fichier `data/jnj2026.db` depuis Render (téléchargez-le
   via le disque persistant, ou via un export que vous ajoutez
   temporairement à une route de debug, ou en SSH si disponible).
2. En local, dans `jnj2026-backend/` :

   ```bash
   npm install
   SQLITE_PATH=/chemin/vers/jnj2026.db \
   DATABASE_URL="postgresql://postgres.xxxx:MOTDEPASSE@...pooler.supabase.com:6543/postgres" \
   npm run migrate
   ```

3. Le script affiche le nombre d'enregistrements migrés pour
   `app_state` (préinscriptions, inscrits, mur, galerie, objets perdus,
   etc.), `visits` et `sessions`.

Si vous démarrez sans données existantes (nouveau déploiement), passez
directement à l'étape 4 — `schema.sql` insère déjà un état initial vide.

---

## 4. Déployer le backend sur Render

1. Poussez le contenu mis à jour de `jnj2026-backend/` (avec le nouveau
   `server.js`, `package.json`, et le dossier `migration/`) sur votre
   dépôt Git.
2. Sur Render, ouvrez votre service existant (ou créez-en un nouveau
   **Web Service**) :
   - **Build command** : `npm install`
   - **Start command** : `node server.js`
3. **Variables d'environnement** (Render → Environment) :

   | Variable | Valeur | Obligatoire |
   |---|---|---|
   | `DATABASE_URL` | Chaîne de connexion Supabase (pooler, port 6543) | ✅ Oui |
   | `PORT` | laissé vide (Render le fixe automatiquement) | non |
   | `PASS_HYPERVISEUR` | nouveau mot de passe fort | recommandé |
   | `PASS_SUPERVISEUR` | nouveau mot de passe fort | recommandé |
   | `PASS_ADMIN` | nouveau mot de passe fort | recommandé |
   | `PASS_GESTIONNAIRE` | nouveau mot de passe fort | recommandé |
   | `PASS_UTILISATEUR` | nouveau mot de passe fort | recommandé |
   | `PG_POOL_MAX` | `5` (par défaut, ajustable) | non |

   ⚠️ **Vous pouvez désormais supprimer le disque persistant Render**
   (`data/` n'est plus utilisé) — toutes les données vivent dans
   Supabase.

4. Déployez. Au démarrage, le serveur :
   - vérifie/crée les tables si besoin (`ensureSchema`),
   - écoute sur le port fourni par Render,
   - se connecte à Supabase via `DATABASE_URL`.

5. Vérifiez `https://votre-service.onrender.com/api/health` → doit
   renvoyer `{"ok":true,"db":"supabase-postgres","version":N,...}`.

---

## 5. Déployer le frontend

Aucun changement de logique requis. Deux options, comme avant :

### Option A — Même serveur que le backend
Placez `jnj2026.html` (renommé `index.html`) dans `jnj2026-backend/public/`.
Gardez :
```html
<script>window.JNJ_API_BASE = '';</script>
```

### Option B — Frontend séparé (GitHub Pages, Netlify, etc.)
Modifiez en haut du `<head>` :
```html
<script>window.JNJ_API_BASE = 'https://votre-service.onrender.com';</script>
```

Le fichier `jnj2026-frontend.html` fourni contient déjà cette
configuration commentée à jour, ainsi qu'une **reconnexion SSE plus
robuste** (backoff exponentiel + polling de secours toutes les 8s si la
connexion temps réel échoue — utile sur Render Free qui peut mettre le
service en veille après inactivité).

---

## 6. Vérification multi-appareils (checklist)

1. Ouvrez la plateforme sur le **téléphone A** → faites une préinscription.
2. Ouvrez la plateforme sur le **téléphone B** → **Espace Gérant →
   Préinscriptions en attente** → la préinscription apparaît
   automatiquement (SSE) ou après rafraîchissement.
3. Publiez une note sur le **Mur Collaboratif** depuis B → apparaît sur
   A en quelques secondes.
4. Visitez depuis 2 appareils → le compteur "Visiteurs aujourd'hui"
   reflète bien le total réel (2).
5. **Redéployez le service Render** (ou laissez-le se mettre en veille
   puis se réveiller) → toutes les données sont toujours là, car elles
   sont stockées dans Supabase et non sur le disque Render.
6. Dans Supabase → **Table Editor → app_state**, vérifiez que la colonne
   `data` (jsonb) contient bien vos préinscriptions, inscrits, mur,
   galerie, objets perdus, etc.

---

## 7. Notes sur la concurrence et les limites

- **Concurrence** : identique à avant — contrôle de version optimiste
  sur `app_state` via une transaction PostgreSQL (`SELECT ... FOR
  UPDATE`). En cas de conflit, le client reçoit un `409`, recharge l'état
  serveur et retente automatiquement.
- **Temps réel** : le flux SSE existant (`/api/events`) reste la source
  principale de synchronisation, désormais complété par un polling de
  secours côté frontend. La table `app_state` est aussi activée pour
  **Supabase Realtime** (Postgres Changes) si vous souhaitez, à terme,
  vous abonner directement depuis le frontend via le SDK
  `@supabase/supabase-js` (non requis pour le fonctionnement actuel).
- **Authentification** : niveau "simple" inchangé (mots de passe en
  clair + token de session, table `sessions`). Avant un déploiement
  national à grande échelle, prévoir hachage bcrypt + limitation des
  tentatives.
- **Photos/signatures** : toujours en base64 dans `app_state.data`
  (colonne `jsonb`). Pour de gros volumes, envisager **Supabase
  Storage** (bucket S3-compatible) avec uniquement l'URL stockée en
  base — évolution future, non requise pour cette migration.
- **Limites Supabase Free** : 500 Mo de base de données et 2 projets
  actifs gratuits. Un état JSON de quelques Mo avec photos en base64
  reste viable, mais surveillez la taille de `app_state.data` si le
  volume de photos/signatures augmente fortement.
