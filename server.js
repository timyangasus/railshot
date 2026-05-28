const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.TDX_CLIENT_ID;
const CLIENT_SECRET = process.env.TDX_CLIENT_SECRET;

app.use(cors());
app.use(express.json());
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

// ── Station ID cache ─────────────────────────────────
let stationCache = null;  // { '臺北': '1000', '高雄': '3300', ... }

async function getStationMap() {
  if (stationCache) return stationCache;
  const data = await tdx('/api/basic/v3/Rail/TRA/Station?$format=JSON');
  const stations = data.Stations || data;
  stationCache = {};
  stations.forEach(s => {
    const zhName = (s.StationName?.Zh_tw || s.StationName || '').trim();
    const id = s.StationID || s.StationId || '';
    if (zhName && id) stationCache[zhName] = id;
  });
  console.log(`Loaded ${Object.keys(stationCache).length} stations`);
  return stationCache;
}

async function resolveStationId(name) {
  // 若已經是數字 ID 直接回傳
  if (/^\d+$/.test(name)) return name;
  const map = await getStationMap();
  return map[name] || name;
}

// ── Health check ─────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── 1. OD 時刻查詢 ───────────────────────────────────
app.get('/api/od/:from/:to/:date', async (req, res) => {
  try {
    const { from, to, date } = req.params;
    const fromId = await resolveStationId(decodeURIComponent(from));
    const toId = await resolveStationId(decodeURIComponent(to));
    console.log(`OD query: ${from}(${fromId}) → ${to}(${toId}) on ${date}`);
    const data = await tdx(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/OD/${fromId}/to/${toId}/${date}?$format=JSON`
    );
    res.json(data);
  } catch (e) {
    console.error('OD error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 2. 依車站查詢當日經過班次 ────────────────────────
app.get('/api/station/:stationId/:date', async (req, res) => {
  try {
    const { stationId, date } = req.params;
    const id = await resolveStationId(decodeURIComponent(stationId));
    console.log(`Station query: ${stationId}(${id}) on ${date}`);
    const data = await tdx(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/Station/${id}/${date}?$format=JSON`
    );
    res.json(data);
  } catch (e) {
    console.error('Station error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 3. 即時誤點 ───────────────────────────────────────
app.get('/api/live', async (req, res) => {
  try {
    const data = await tdx('/api/basic/v3/Rail/TRA/TrainLiveBoard?$format=JSON&$top=500');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 4. 車站清單 ───────────────────────────────────────
app.get('/api/stations', async (req, res) => {
  try {
    const map = await getStationMap();
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 啟動時預載車站資料
app.listen(PORT, async () => {
  console.log(`Railshot proxy running on port ${PORT}`);
  try {
    await getStationMap();
  } catch(e) {
    console.error('Failed to preload stations:', e.message);
  }
});
