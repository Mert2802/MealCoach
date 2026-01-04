# Meal Coach

Web-App + Backend fuer konstante Erinnerungen, Check-ins und OpenAI-Fotoanalyse.

## Voraussetzungen
- Node.js 20+
- Firebase CLI (`npm i -g firebase-tools`)
- Firebase Projekt (z.B. `mealcoach-b794d`)
- OpenAI API Key

## Setup (Firebase)
1) VAPID Keys fuer Push (einmalig)
```
cd server
npm install
node scripts/generate-vapid.js
```

2) Firebase Functions Config setzen
```
firebase use mealcoach-b794d
firebase functions:config:set openai.key="OPENAI_API_KEY"
firebase functions:config:set vapid.public="VAPID_PUBLIC_KEY" vapid.private="VAPID_PRIVATE_KEY" vapid.subject="mailto:you@example.com"
```

3) Web-ENV anlegen
```
cd ..\web
copy .env.example .env
```
Eintragen:
- VITE_VAPID_PUBLIC_KEY (aus Schritt 1)
- VITE_API_URL (leer lassen fuer Firebase Hosting / Rewrites)

## Lokal starten (Emulator + Vite)
Terminal 1:
```
cd functions
npm install
firebase emulators:start --only functions,firestore
```

Terminal 2:
```
cd ..\web
npm install
set VITE_API_URL=http://127.0.0.1:5001/mealcoach-b794d/us-central1/api
npm run dev
```

Open http://localhost:5173

## Deploy (Hosting + Functions)
```
cd web
npm run build
cd ..
firebase deploy
```

## Hinweise
- Firebase Functions braucht den Blaze Plan (kostenpflichtig), hat aber Free-Tier Kontingente.
- Ohne Backend funktionieren Foto-Analyse, Check-ins und Push nicht.
- Push braucht HTTPS in Produktion.
- Automatische Erinnerungen via Cron sind im kostenlosen Plan nicht enthalten. Optional: `/api/nag-check` regelmaessig aus der App oder ueber einen externen kostenlosen Scheduler aufrufen.

## GitHub Actions (gratis Cron)
Wenn das Repo auf GitHub liegt, ruft der Workflow `.github/workflows/nag-check.yml` alle 10 Minuten
`https://mealcoach-b794d.web.app/api/nag-check` auf.
