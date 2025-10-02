# GIS Sentinel Overlay API

This project exposes an API to generate a clipped (masked) Sentinel LULC overlay image for a selected State or Village in India. The PNG (and bounds) can be used to overlay on Mapbox GL JS or other web maps.

## Endpoints

- `GET /overlay?state=Odisha[&village=Angul][&size=2048][&format=png|json]`
  - Returns a transparent PNG clipped to the requested polygon. Default PNG output.
  - `format=json` returns `{ image: dataUrl, bounds: [west,south,east,north], width, height }`.
  - `size` is the longer side (128–4096), default 1024.
- `GET /api/overlay` — same as above (alias under `/api`).
- `GET /api/mask?state=Odisha[&village=Angul]` — returns the matched feature (Esri JSON). Useful for debugging.

## Local development

1. Install dependencies and start the server:

```bat
cd "c:\Users\Acer\Desktop\API's\gis-sentinel"
npm install
npm start
```

2. Test endpoints:

- PNG: `http://localhost:3000/overlay?state=Odisha`
- JSON: `http://localhost:3000/overlay?state=Odisha&village=Angul&size=2048&format=json`

## Use with Mapbox GL JS

```js
const res = await fetch('/overlay?state=Odisha&village=Angul&size=2048&format=json').then(r => r.json());
const [w, s, e, n] = res.bounds;
map.addSource('sentinelOverlay', {
  type: 'image',
  url: res.image,
  coordinates: [ [w, n], [e, n], [e, s], [w, s] ]
});
map.addLayer({ id: 'sentinelOverlay-layer', type: 'raster', source: 'sentinelOverlay', paint: { 'raster-opacity': 0.95 } });
map.fitBounds([[w, s], [e, n]], { padding: 40 });
```

## Push to GitHub

1. Initialize git (if not already):

```bat
git init
git add .
git commit -m "feat: sentinel overlay API"
```

2. Create a new GitHub repository (via UI or CLI) — e.g., `gis-sentinel`.

3. Add the remote and push main branch:

```bat
git branch -M main
git remote add origin https://github.com/<YOUR_USERNAME>/gis-sentinel.git
git push -u origin main
```

## Deploy to Vercel

1. Install the Vercel CLI and login (one-time):

```bat
npm i -g vercel
vercel login
```

2. From the project folder, deploy:

```bat
vercel
```

Follow the prompts. On subsequent deploys:

```bat
vercel --prod
```

Vercel will use `vercel.json`:
- `server.js` is deployed as a serverless function.
- `index.html` is served as static (optional demo page).
- Routes are configured for `/overlay`, `/api/overlay`, and `/api/mask`.

## Caching

Responses include:
- `Cache-Control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=600`
This enables browser and edge caching to reduce latency and load times.

## Notes

- State filter uses `State_FSI` with case-insensitive LIKE.
- Village filter uses `name` (and optional `state`) with case-insensitive LIKE.
- The overlay is a single image sized by `size`; for wide areas or deep zooms consider increasing `size` or implementing a tile-based endpoint.

## License

MIT
