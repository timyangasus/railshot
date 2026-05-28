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

async function tdxWithRetry(path, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const token = await getToken();
      const res = await fetch(`https://tdx.transportdata.tw${path}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 429) {
        if (i < retries) {
          console.log('Rate limited, waiting 2s...');
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw new Error('TDX 429: 請求過於頻繁，請稍後再試');
      }
      if (!res.ok) throw new Error(`TDX ${res.status}: ${path}`);
      return res.json();
    } catch (e) {
      if (i === retries) throw e;
    }
  }
}

async function resolveStationId(name) {
  if (/^\d+$/.test(name)) return name;
  const map = await getStationMap();
  if (map[name]) return map[name];
  const alt = name.replace(/^台/, '臺').replace(/^臺/, '台');
  if (map[alt]) return map[alt];
  console.warn(`Station not found: "${name}"`);
  return name;
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── Station ID cache ─────────────────────────────────
let stationCache = null;  // { '臺北': '1000', '高雄': '3300', ... }

async function getStationMap() {
  if (stationCache) return stationCache;
  const data = await tdx('/api/basic/v3/Rail/TRA/Station?$format=JSON');
  // TDX v3 可能的格式：{ Stations: [...] } 或直接 [...]
  let stations = [];
  if (Array.isArray(data)) stations = data;
  else if (Array.isArray(data.Stations)) stations = data.Stations;
  else if (Array.isArray(data.value)) stations = data.value;

  stationCache = {};
  stations.forEach(s => {
    // 中文站名可能在不同欄位
    const zhName = (
      s.StationName?.Zh_tw ||
      s.StationName?.ZhTw ||
      (typeof s.StationName === 'string' ? s.StationName : '') ||
      ''
    ).trim();
    const id = String(s.StationID || s.StationId || s.StationCode || '').trim();
    if (zhName && id) stationCache[zhName] = id;
  });
  console.log(`Loaded ${Object.keys(stationCache).length} stations`);
  if (Object.keys(stationCache).length > 0) {
    // 印出前5筆確認格式
    const sample = Object.entries(stationCache).slice(0, 5);
    console.log('Sample stations:', JSON.stringify(sample));
  }
  return stationCache;
}

app.get('/api/od/:from/:to/:date', async (req, res) => {
  try {
    const { from, to, date } = req.params;
    const fromId = await resolveStationId(decodeURIComponent(from));
    const toId = await resolveStationId(decodeURIComponent(to));
    console.log(`OD query: ${from}(${fromId}) → ${to}(${toId}) on ${date}`);
    const data = await tdxWithRetry(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/OD/${fromId}/to/${toId}/${date}?$format=JSON`
    );

    // 二次驗證：確保每班車的停靠站列表中真的包含出發站
    if (data.TrainTimetables) {
      // Debug: 印出第一班車的停靠站 ID 格式
      if (data.TrainTimetables.length > 0) {
        const firstStops = (data.TrainTimetables[0].StopTimes || []).slice(0, 3);
        console.log('Sample StopTimes IDs:', JSON.stringify(firstStops.map(s => ({
          id: s.StationID, name: (s.StationName||{}).Zh_tw
        }))));
      }
      const before = data.TrainTimetables.length;
      data.TrainTimetables = data.TrainTimetables.filter(tt => {
        const stops = tt.StopTimes || [];
        return stops.some(s => String(s.StationID || '') === String(fromId));
      });
      console.log(`After filter: ${data.TrainTimetables.length}/${before} trains actually stop at ${from}(${fromId})`);

      // Debug: 印出前3班車種
      const sample = data.TrainTimetables.slice(0, 3).map(tt => ({
        no: tt.TrainInfo?.TrainNo,
        typeCode: tt.TrainInfo?.TrainTypeCode,
        typeName: tt.TrainInfo?.TrainTypeName?.Zh_tw
      }));
      console.log('Train type sample:', JSON.stringify(sample));
    }

    res.json(data);
  } catch (e) {
    console.error('OD error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/station/:stationId/:date', async (req, res) => {
  try {
    const { stationId, date } = req.params;
    const id = await resolveStationId(decodeURIComponent(stationId));
    console.log(`Station query: ${stationId}(${id}) on ${date}`);
    const data = await tdxWithRetry(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/Station/${id}/${date}?$format=JSON`
    );
    res.json(data);
  } catch (e) {
    console.error('Station error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/live', async (req, res) => {
  try {
    const data = await tdxWithRetry('/api/basic/v3/Rail/TRA/TrainLiveBoard?$format=JSON&$top=500');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stations', async (req, res) => {
  try {
    const map = await getStationMap();
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 5. 單一車次完整停靠站 ────────────────────────────
app.get('/api/train/:trainNo/:date', async (req, res) => {
  try {
    const { trainNo, date } = req.params;
    const data = await tdxWithRetry(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/TrainNo/${trainNo}/${date}?$format=JSON`
    );
    res.json(data);
  } catch (e) {
    console.error('Train error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.listen(PORT, async () => {
  console.log(`Railshot proxy running on port ${PORT}`);
  try {
    await getStationMap();
  } catch(e) {
    console.error('Failed to preload stations:', e.message);
  }
});
