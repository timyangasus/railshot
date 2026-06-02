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

// ── Token ─────────────────────────────────────────────
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

async function tdxFetch(urlPath, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const token = await getToken();
      const res = await fetch(`https://tdx.transportdata.tw${urlPath}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 429) {
        const wait = (i + 1) * 3000;
        console.log(`429 retry ${i+1} after ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`TDX ${res.status}: ${urlPath}`);
      return res.json();
    } catch(e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ── Train type mapping ────────────────────────────────
function getTrainType(info) {
  const name = (info.TrainTypeName?.Zh_tw || '');
  const code = String(info.TrainTypeCode || '');
  if (name.includes('普悠瑪')) return 'puy';
  if (name.includes('太魯閣')) return 'tze';
  if (name.includes('EMU3000') || name.includes('3000')) return 'exp3';
  if (name.includes('莒光')) return 'moc';
  if (name.includes('區間快')) return 'localx';
  if (name.includes('區間')) return 'local';
  const map = { '1':'tze','2':'puy','3':'exp','4':'exp','5':'exp3',
    '6':'local','7':'localx','8':'moc','9':'moc','10':'localx','11':'exp3','12':'local' };
  return map[code] || 'exp';
}

// ── GeneralTrainTimetable cache & index ───────────────
let gttCache = null;       // 前端 payload
let trainIndex = null;     // trainNo -> trainData
let stationIndex = null;   // stationName -> [{no,type,dir,from,to,time}]
let cacheBuiltAt = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24hr

async function buildIndex() {
  if (gttCache && Date.now() - cacheBuiltAt < CACHE_TTL) return;
  console.log('Building GeneralTrainTimetable index...');

  const data = await tdxFetch('/api/basic/v3/Rail/TRA/GeneralTrainTimetable?$format=JSON');
  const timetables = data.TrainTimetables || data || [];

  trainIndex = {};
  stationIndex = {};
  const trains = [];

  for (const tt of timetables) {
    const info = tt.TrainInfo || {};
    const rawStops = tt.StopTimes || [];

    const trainNo = String(info.TrainNo || '');
    const type = getTrainType(info);
    // TDX Direction: 0=下行(南下), 1=上行(北上)
    const dir = info.Direction === 0 ? 'down' : 'up';
    const from = info.StartingStationName?.Zh_tw || '';
    const to   = info.EndingStationName?.Zh_tw   || '';

    const stops = rawStops
      .sort((a, b) => a.StopSequence - b.StopSequence)
      .map(s => ({
        id:  String(s.StationID || ''),
        stn: s.StationName?.Zh_tw || '',
        arr: s.ArrivalTime   || '',
        dep: s.DepartureTime || '',
      }));

    const trainData = { no: trainNo, type, dir, from, to, stops };
    trainIndex[trainNo] = trainData;
    trains.push(trainData);

    // ── stationIndex ───────────────────────────────────
    for (const stop of stops) {
      if (!stop.stn) continue;
      if (!stationIndex[stop.stn]) stationIndex[stop.stn] = [];
      stationIndex[stop.stn].push({
        no: trainNo, type, dir, from, to,
        time: stop.dep || stop.arr,
      });
    }

    // stopSet：O(1) 判斷列車是否停靠某站（兩站之間查詢用）
    trainData.stopSet = new Set(stops.map(s => s.stn).filter(Boolean));
  }

  // 驗證方向：用大湖→路竹（下行）& 路竹→大湖（上行）測試
  const downSample = (stationIndex['大湖'] || []).find(t => {
    const train = trainIndex[t.no];
    const i1 = train.stops.findIndex(s => s.stn === '大湖');
    const i2 = train.stops.findIndex(s => s.stn === '路竹');
    return i2 > i1;
  });
  const upSample = (stationIndex['路竹'] || []).find(t => {
    const train = trainIndex[t.no];
    const i1 = train.stops.findIndex(s => s.stn === '路竹');
    const i2 = train.stops.findIndex(s => s.stn === '大湖');
    return i2 > i1;
  });
  console.log(`Direction check 大湖→路竹(down): ${downSample ? downSample.no + ' dir=' + downSample.dir : 'none'}`);
  console.log(`Direction check 路竹→大湖(up):   ${upSample  ? upSample.no  + ' dir=' + upSample.dir  : 'none'}`);

  gttCache = { trains, builtAt: Date.now() };
  cacheBuiltAt = Date.now();
  console.log(`Index built: ${trains.length} trains, ${Object.keys(stationIndex).length} stations`);
}

// ── Live cache (60s) ──────────────────────────────────
let liveCache = null;
let liveCacheAt = 0;

async function getLiveMap() {
  if (liveCache && Date.now() - liveCacheAt < 60000) return liveCache;
  try {
    const data = await tdxFetch('/api/basic/v3/Rail/TRA/TrainLiveBoard?$format=JSON&$top=500');
    const map = {};
    (data.TrainLiveBoards || data || []).forEach(t => {
      map[t.TrainNo] = t.DelayTime || 0;
    });
    liveCache = map;
    liveCacheAt = Date.now();
    return map;
  } catch(e) {
    console.log('Live unavailable');
    return liveCache || {};
  }
}

// ── Health ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    indexed: !!gttCache,
    trains: gttCache ? gttCache.trains.length : 0,
    stations: stationIndex ? Object.keys(stationIndex).length : 0,
    builtAt: cacheBuiltAt ? new Date(cacheBuiltAt).toISOString() : null,
  });
});

// ── 全量時刻資料（前端用）────────────────────────────
app.get('/api/timetable', async (req, res) => {
  try {
    await buildIndex();
    res.json(gttCache);
  } catch(e) {
    console.error('timetable error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 單站查詢（server 側過濾，備用）──────────────────
app.get('/api/station/:name', async (req, res) => {
  try {
    await buildIndex();
    const name = decodeURIComponent(req.params.name);
    const list = stationIndex[name] || stationIndex[name.replace(/台/g,'臺')] || [];
    res.json({ station: name, trains: list });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 列車詳細（by trainNo）────────────────────────────
app.get('/api/train/:no', async (req, res) => {
  try {
    await buildIndex();
    const no = req.params.no;
    const train = trainIndex[no];
    if (!train) return res.status(404).json({ error: 'Train not found' });
    // 疊加誤點
    const liveMap = await getLiveMap();
    res.json({ ...train, delay: liveMap[no] || 0 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 時刻表 OD（時刻表 tab 用）────────────────────────
app.get('/api/od/:from/:to/:date', async (req, res) => {
  try {
    const { from, to, date } = req.params;

    await buildIndex();
    const fromName = decodeURIComponent(from);
    const toName   = decodeURIComponent(to);

    const results = [];
    for (const train of gttCache.trains) {
      const i1 = train.stops.findIndex(s => s.stn === fromName || s.stn === fromName.replace(/台/g,'臺'));
      const i2 = train.stops.findIndex(s => s.stn === toName   || s.stn === toName.replace(/台/g,'臺'));
      if (i1 < 0 || i2 < 0 || i2 <= i1) continue;
      const depStop = train.stops[i1];
      const arrStop = train.stops[i2];
      results.push({
        no: train.no, type: train.type, dir: train.dir,
        from: fromName, to: toName,
        dep: depStop.dep || depStop.arr,
        arr: arrStop.arr || arrStop.dep,
        stops: train.stops,
      });
    }
    results.sort((a, b) => a.dep.localeCompare(b.dep));

    const liveMap = await getLiveMap();
    results.forEach(r => { r.delay = liveMap[r.no] || 0; });

    res.json({ from: fromName, to: toName, date, trains: results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Live ─────────────────────────────────────────────
app.get('/api/live', async (req, res) => {
  try {
    const map = await getLiveMap();
    res.json({ TrainLiveBoards: Object.entries(map).map(([TrainNo, DelayTime]) => ({ TrainNo, DelayTime })) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stations list ─────────────────────────────────────
app.get('/api/stations', async (req, res) => {
  try {
    await buildIndex();
    res.json(Object.keys(stationIndex).sort());
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Railshot server on port ${PORT}`);
  // 啟動時預先建立索引
  buildIndex().catch(e => console.error('Index build failed:', e.message));
});
