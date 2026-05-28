const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.TDX_CLIENT_ID;
const CLIENT_SECRET = process.env.TDX_CLIENT_SECRET;

app.use(cors());
app.use(express.json());

// 提供靜態檔案（index.html、icon.svg、manifest.json）
app.use(express.static(path.join(__dirname)));

// ── Token cache ──────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(
    'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
    }
  );
  if (!res.ok) throw new Error(`Token error: ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function tdx(path) {
  const token = await getToken();
  const res = await fetch(`https://tdx.transportdata.tw${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`TDX ${res.status}: ${path}`);
  return res.json();
}

// ── Health check ─────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── 1. OD 時刻查詢（出發站→到達站）─────────────────
//   GET /api/od/:from/:to/:date
//   from/to: TDX StationID (e.g. Taipei, Kaohsiung)
//   date: YYYY-MM-DD
app.get('/api/od/:from/:to/:date', async (req, res) => {
  try {
    const { from, to, date } = req.params;
    const data = await tdx(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/OD/${from}/to/${to}/${date}?$format=JSON`
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 2. 依車站查詢當日經過班次（拍車用）──────────────
//   GET /api/station/:stationId/:date
//   回傳當天所有經過該站的班次
app.get('/api/station/:stationId/:date', async (req, res) => {
  try {
    const { stationId, date } = req.params;
    const data = await tdx(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/Station/${stationId}/${date}?$format=JSON`
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 3. 即時誤點資訊 ───────────────────────────────────
//   GET /api/live
app.get('/api/live', async (req, res) => {
  try {
    const data = await tdx(
      '/api/basic/v3/Rail/TRA/TrainLiveBoard?$format=JSON&$top=500'
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 4. 車站清單 ───────────────────────────────────────
//   GET /api/stations
app.get('/api/stations', async (req, res) => {
  try {
    const data = await tdx('/api/basic/v3/Rail/TRA/Station?$format=JSON');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Railshot proxy running on port ${PORT}`));
