import express from 'express';
import cors from 'cors';
import serverless from 'serverless-http';
import sharp from 'sharp';

const app = express();
app.use(cors());
app.use(express.json());

// (no-op utility section)

const VILLAGE_URL = 'https://livingatlas.esri.in/server/rest/services/IAB2024/IAB_Village_2024/MapServer/0/query';
const STATE_URL = 'https://services5.arcgis.com/73n8CSGpSSyHr1T9/arcgis/rest/services/state_boundary/FeatureServer/0/query';
const LULC_EXPORT = 'https://livingatlas.esri.in/server/rest/services/Sentinel_Lulc/MapServer/export';

async function arcgisQuery(url, params) {
  const sp = new URLSearchParams({ f: 'json', ...params });
  const res = await fetch(`${url}?${sp.toString()}`);
  if (!res.ok) throw new Error(`ArcGIS query failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'ArcGIS error');
  return data;
}

// Query geometry by village/state; returns { level, feature } in 3857
async function getMaskFeature({ state = '', village = '' }) {
  if (village) {
    const whereParts = [
      `LOWER(name) LIKE '%${String(village).toLowerCase().replace(/[%'_]/g, '')}%'`
    ];
    if (state) whereParts.push(`LOWER(state) LIKE '%${String(state).toLowerCase().replace(/[%'_]/g, '')}%'`);
    const resVillage = await arcgisQuery(VILLAGE_URL, {
      where: whereParts.join(' AND '),
      returnGeometry: 'true',
      outFields: '*',
      outSR: '3857',
      num: '1'
    });
    if (!resVillage.features?.length) throw new Error('Village not found');
    return { level: 'village', feature: resVillage.features[0] };
  }
  const resState = await arcgisQuery(STATE_URL, {
    where: `LOWER(State_FSI) LIKE '%${String(state).toLowerCase().replace(/[%'_]/g, '')}%'`,
    returnGeometry: 'true',
    outFields: '*',
    outSR: '3857',
    num: '1'
  });
  if (!resState.features?.length) throw new Error('State not found');
  return { level: 'state', feature: resState.features[0] };
}

function extentFromGeometry(geom) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  const rings = geom?.rings || [];
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < xmin) xmin = x;
      if (y < ymin) ymin = y;
      if (x > xmax) xmax = x;
      if (y > ymax) ymax = y;
    }
  }
  return { xmin, ymin, xmax, ymax };
}

function expandExtent(ext, factor = 1.04) {
  const cx = (ext.xmin + ext.xmax) / 2;
  const cy = (ext.ymin + ext.ymax) / 2;
  const w = (ext.xmax - ext.xmin) * factor;
  const h = (ext.ymax - ext.ymin) * factor;
  return { xmin: cx - w / 2, ymin: cy - h / 2, xmax: cx + w / 2, ymax: cy + h / 2 };
}

function mercatorToWgs84Bounds(ext) {
  const R = 6378137;
  const toLon = (x) => (x / R) * 180 / Math.PI;
  const toLat = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
  const west = toLon(ext.xmin);
  const east = toLon(ext.xmax);
  let south = toLat(ext.ymin);
  let north = toLat(ext.ymax);
  // Clamp latitude to Web Mercator limits
  south = Math.max(-85.05112878, Math.min(85.05112878, south));
  north = Math.max(-85.05112878, Math.min(85.05112878, north));
  return [west, south, east, north];
}

function geometryToSvgMask(geom, width, height, ext) {
  const sx = width / (ext.xmax - ext.xmin);
  const sy = height / (ext.ymax - ext.ymin);
  const toPx = (x, y) => {
    const px = (x - ext.xmin) * sx;
    const py = height - (y - ext.ymin) * sy; // y down
    return `${px.toFixed(2)},${py.toFixed(2)}`;
  };
  const rings = geom.rings || [];
  const paths = rings.map(ring => 'M ' + ring.map(([x, y]) => toPx(x, y).replace(',', ' ')).join(' L ') + ' Z');
  const d = paths.join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${d}" fill="#fff" fill-rule="evenodd"/></svg>`;
  return Buffer.from(svg);
}

function sizeFromExtent(ext, maxSize = 1024) {
  const w = Math.max(1, ext.xmax - ext.xmin);
  const h = Math.max(1, ext.ymax - ext.ymin);
  const aspect = w / h;
  let width = maxSize, height = Math.round(maxSize / aspect);
  if (height > maxSize) { height = maxSize; width = Math.round(maxSize * aspect); }
  return { width: Math.max(2, width), height: Math.max(2, height) };
}

// GET /api/mask?state=Odisha&village=Angul
app.get('/api/mask', async (req, res) => {
  try {
    const { state = '', village = '' } = req.query;

    if (!state && !village) {
      return res.status(400).json({ error: 'Provide state and/or village' });
    }
    const data = await getMaskFeature({ state, village });
    return res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
});

// GET /api/overlay?state=Odisha&village=Angul&size=1024&format=png|json
async function overlayHandler(req, res) {
  try {
    const { state = '', village = '', size = '1024', format = 'png' } = req.query;
    if (!state && !village) return res.status(400).json({ error: 'Provide state and/or village' });

    const { feature } = await getMaskFeature({ state, village });
    const geom = feature.geometry;
    const ext = expandExtent(extentFromGeometry(geom), 1.06);
    const { width, height } = sizeFromExtent(ext, Math.min(4096, Math.max(128, Number(size) || 1024)));

    // Build ArcGIS export URL
    const sp = new URLSearchParams({
      f: 'image',
      format: 'png32',
      transparent: 'true',
      bbox: `${ext.xmin},${ext.ymin},${ext.xmax},${ext.ymax}`,
      bboxSR: '3857',
      imageSR: '3857',
      size: `${width},${height}`,
      dpi: '192',
      layers: 'show:0'
    });
    const exportUrl = `${LULC_EXPORT}?${sp.toString()}`;
    const imgRes = await fetch(exportUrl);
    if (!imgRes.ok) throw new Error(`Export failed: ${imgRes.status}`);
    const pngBuffer = Buffer.from(await imgRes.arrayBuffer());

    // Create SVG mask and apply
    const svgMask = geometryToSvgMask(geom, width, height, ext);
    const masked = await sharp(pngBuffer)
      .composite([{ input: svgMask, blend: 'dest-in' }])
      .png()
      .toBuffer();

    const bounds = mercatorToWgs84Bounds(ext);

    if (String(format).toLowerCase() === 'json') {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=600');
      const dataUrl = `data:image/png;base64,${masked.toString('base64')}`;
      return res.json({ image: dataUrl, bounds, width, height });
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=600');
    res.setHeader('X-Bounds', bounds.join(','));
    res.send(masked);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
}

app.get('/api/overlay', overlayHandler);
app.get('/overlay', overlayHandler); // alias for convenience

// API Root
app.get('/', (req, res) => {
  res.json({
    name: 'GIS Sentinel Overlay API',
    endpoints: [
      '/overlay?state=Odisha',
      '/overlay?state=Odisha&village=Angul',
      '/overlay?state=Odisha&village=Angul&size=2048&format=json',
      '/api/mask?state=Odisha'
    ]
  });
});

const PORT = process.env.PORT || 3000;
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
}

export default serverless(app);
