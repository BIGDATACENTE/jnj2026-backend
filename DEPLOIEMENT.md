# JNJ 2026 — Backend centralisé (Guide de déploiement)

## 1. Ce que ce backend résout

Avant : toutes les données (préinscriptions, inscrits, mur collaboratif,
galerie, objets perdus, visiteurs, etc.) étaient stockées dans le
`localStorage` / `sessionStorage` du navigateur — donc **propres à chaque
appareil**, jamais partagées.

Après : un serveur Node.js + base SQLite centralise toutes les données.
Le frontend lit/écrit via une API REST (`/api/db`, `/api/visits/*`,
`/api/login`, etc.) et reçoit les mises à jour des autres appareils en
temps réel via Server-Sent Events (`/api/events`).

## 2. Prérequis

- **Node.js ≥ 22.5** (le serveur utilise le module intégré `node:sqlite`,
  donc aucune compilation native, aucune dépendance lourde).
- Un hébergeur capable d'exécuter un process Node persistant : Render,
  Railway, Fly.io, ou un VPS.

## 3. Structure du projet

```
jnj2026-backend/
├── server.js          # serveur Express + SQLite + SSE
├── package.json
├── data/
│   └── jnj2026.db      # créé automatiquement au premier démarrage
└── public/
    └── index.html       # (optionnel) le frontend, si servi par le même serveur
```

## 4. Installation

```bash
cd jnj2026-backend
npm install
node server.js
```

Le serveur démarre sur le port `3000` par défaut (configurable via la
variable d'environnement `PORT`).

## 5. Variables d'environnement (optionnelles)

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port d'écoute HTTP | `3000` |
| `DB_PATH` | Chemin du fichier SQLite | `./data/jnj2026.db` |
| `PASS_HYPERVISEUR` | Mot de passe du compte `hyperviseur` | `bigdata2026` |
| `PASS_SUPERVISEUR` | Mot de passe du compte `superviseur` | `aumdioc2026` |
| `PASS_ADMIN` | Mot de passe du compte `admin` | `jnj2026` |
| `PASS_GESTIONNAIRE` | Mot de passe du compte `gestionnaire` | `gest2026` |
| `PASS_UTILISATEUR` | Mot de passe du compte `utilisateur` | `user2026` |

**⚠️ IMPORTANT — Avant le déploiement national** : changez impérativement
ces mots de passe par défaut en définissant les variables d'environnement
correspondantes sur votre hébergeur.

## 6. Déploiement du backend (exemple Render.com)

1. Créez un nouveau "Web Service" sur Render, branché sur le dépôt Git
   contenant `jnj2026-backend/`.
2. Build command : `npm install`
3. Start command : `node server.js`
4. Render fournit un montage de disque persistant (ou utilisez
   `DB_PATH` pour pointer vers un volume monté) afin que `data/jnj2026.db`
   survive aux redéploiements.
5. Définissez les variables d'environnement (mots de passe, `PORT` si besoin).
6. Notez l'URL publique générée, par ex. `https://jnj2026-backend.onrender.com`.

## 7. Déploiement du frontend

### Option A — Même serveur que le backend (le plus simple)

Placez `jnj2026.html` (renommé `index.html`) dans le dossier `public/`
du backend. Le serveur Express le sert automatiquement. Dans ce cas,
laissez dans le `<head>` du HTML :

```html
<script>window.JNJ_API_BASE = '';</script>
```

(chaîne vide = même origine, donc aucune configuration CORS supplémentaire
n'est nécessaire).

### Option B — Frontend séparé (GitHub Pages, Netlify, etc.)

Gardez `jnj2026.html` sur votre hébergement statique actuel, mais modifiez
la ligne en haut du `<head>` :

```html
<script>window.JNJ_API_BASE = 'https://jnj2026-backend.onrender.com';</script>
```

Le serveur Express a déjà `cors()` activé pour toutes origines — aucune
configuration CORS supplémentaire n'est nécessaire pour démarrer.
Pour restreindre l'accès à votre seul domaine en production, modifiez dans
`server.js` :

```js
app.use(cors({ origin: 'https://votre-domaine.com' }));
```

## 8. Vérification multi-appareils (checklist)

1. Ouvrez la plateforme sur le **téléphone A** → faites une préinscription.
2. Ouvrez la plateforme sur le **téléphone B** (ou un autre navigateur) →
   allez dans **Espace Gérant → Préinscriptions en attente** → la
   préinscription du téléphone A doit apparaître **sans rechargement**
   (mise à jour reçue via SSE) ou après un simple rafraîchissement de page.
3. Sur le téléphone B, publiez une note sur le **Mur Collaboratif** →
   elle doit apparaître sur le téléphone A en quelques secondes.
4. Visitez la plateforme depuis 2 appareils différents → le compteur
   "Visiteurs aujourd'hui" dans l'en-tête doit refléter le total réel
   (2), pas "1" sur chaque appareil.
5. Redémarrez le serveur backend (`Ctrl+C` puis relancer `node server.js`)
   → toutes les données doivent être toujours présentes (persistées dans
   `data/jnj2026.db`).

## 9. Limites connues et pistes d'évolution

- **Concurrence** : l'API utilise un numéro de version optimiste sur l'état
  global. En cas d'écritures simultanées très rapprochées sur le même
  enregistrement par deux appareils différents, l'un des deux peut recevoir
  un conflit 409 — le client recharge alors automatiquement l'état serveur
  et retente. Pour un très grand volume concurrent, une migration vers des
  tables relationnelles dédiées (une table par collection : `preins`, `ins`,
  `wall`, etc.) avec des écritures ciblées serait l'étape suivante.
- **Authentification** : niveau "simple" (mots de passe en clair côté
  serveur + token de session). Avant un déploiement national à grande
  échelle, prévoir : hachage bcrypt des mots de passe, JWT, limitation des
  tentatives de connexion (brute-force).
- **Photos/signatures** : actuellement stockées en base64 dans l'état JSON
  (comme avant). Pour de gros volumes, migrer vers un stockage de fichiers
  (ex: dossier `uploads/` ou stockage objet S3-compatible) avec uniquement
  l'URL stockée en base.
