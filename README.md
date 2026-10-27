# Dehla Pakad

Mindi Coat with our house rules, played with friends on phones.

**Live:** https://dehla-pakad-z5re.onrender.com (open on a phone, then "Add to Home Screen")

## What's here
- `server/engine.js` – the rules: turup decide hona, dehla pakadna (two in a row), last haath, Kot.
- `server/room.js` – friends tables: codes, seats, host controls, 60s timer with highest-card auto-play, bots, reconnecting, Kot table scoring.
- `server/index.js` – serves the app and the WebSocket (`/ws`).
- `public/` – the app (one page), PWA manifest, icons, service worker.
- `test/sim.js` – four simulated phones play a full table: `npm test`.

## Run locally
```
npm install
npm start        # http://localhost:3000
```

Hosted on Render (Singapore, free plan). Every push to `main` redeploys.
