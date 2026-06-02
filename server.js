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

// ── Timetable cache & index ──────────────────────────
let gttCache = null;
let trainIndex = null;
let stationIndex = null;
let cacheBuiltAt = 0;
let cacheDate = '';
const CACHE_TTL = 20 * 60 * 60 * 1000; // 20hr

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

async function buildIndex() {
  const today = todayStr();
  if (gttCache && cacheDate === today && Date.now() - cacheBuiltAt < CACHE_TTL) return;
  console.log(`Building timetable index for ${today}...`);

  let timetables = [];
  let source = '';
  try {
    const data = await tdxFetch(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${today}?$format=JSON`
    );
    timetables = data.TrainTimetables || data || [];
    source = 'DailyTrainTimetable';
    console.log(`DailyTrainTimetable: ${timetables.length} trains`);
  } catch(e) {
    console.warn(`DailyTrainTimetable failed (${e.message}), fallback to GeneralTrainTimetable`);
    const data = await tdxFetch('/api/basic/v3/Rail/TRA/GeneralTrainTimetable?$format=JSON');
    timetables = data.TrainTimetables || data || [];
    source = 'GeneralTrainTimetable(fallback)';
    console.log(`GeneralTrainTimetable fallback: ${timetables.length} trains`);
  }

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

  gttCache = { trains, builtAt: Date.now(), date: today, source };
  cacheBuiltAt = Date.now();
  cacheDate = today;
  console.log(`Index built [${source}]: ${trains.length} trains, ${Object.keys(stationIndex).length} stations`);
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
    source: gttCache?.source || null,
    date: gttCache?.date || null,
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
app.get('/api/debug/train/:no', async (req, res) => {
  try {
    await buildIndex();
    const no = req.params.no;
    const train = trainIndex[no];
    if (!train) return res.json({ found: false, no, source: gttCache?.source });
    res.json({ found: true, source: gttCache?.source, date: gttCache?.date, train });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug: 竹北通過列車清單（含估算細節）─────────────
app.get('/api/debug/zhubei', async (req, res) => {
  try {
    await buildIndex();
    const TARGET = '竹北';
    const TARGET_KM = 77.6;
    const STATION_KM_SERVER = {
      '基隆':0,'三坑':3.4,'八堵':6.0,'七堵':7.6,'百福':9.2,'五堵':11.0,
      '汐止':13.0,'汐科':14.5,'南港':19.0,'松山':21.4,'臺北':27.7,'萬華':29.5,
      '板橋':33.2,'浮洲':34.9,'樹林':37.0,'南樹林':38.4,'山佳':39.8,'鶯歌':42.4,
      '鳳鳴':44.0,'桃園':47.4,'內壢':50.0,'中壢':52.6,'埔心':55.4,'楊梅':59.2,
      '富岡':62.8,'新富':65.0,'北湖':68.0,'湖口':70.3,'新豐':74.0,'竹北':77.6,
      '新竹':80.8,'三姓橋':83.7,'香山':86.0,
    };

    const results = [];
    for (const train of gttCache.trains) {
      // 找前後站
      let prev = null, next = null;
      for (const stop of train.stops) {
        const km = STATION_KM_SERVER[stop.stn];
        if (km === undefined) continue;
        const t = stop.dep || stop.arr;
        if (!t) continue;
        if (km <= TARGET_KM) prev = { stn: stop.stn, km, t };
        else if (km > TARGET_KM && !next) next = { stn: stop.stn, km, t };
      }
      if (!prev || !next) continue;

      // 計算估算時間
      const prevMins = parseInt(prev.t.split(':')[0]) * 60 + parseInt(prev.t.split(':')[1]);
      const nextMins = parseInt(next.t.split(':')[0]) * 60 + parseInt(next.t.split(':')[1]);
      const ratio = (TARGET_KM - prev.km) / (next.km - prev.km);
      const estMins = Math.round(prevMins + ratio * (nextMins - prevMins));
      const h = Math.floor(estMins / 60) % 24;
      const m = estMins % 60;
      const estTime = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;

      // 只要 16:30～17:00 的
      if (estMins < 16*60+30 || estMins > 17*60+0) continue;

      // 確認是否直接停靠竹北
      const directStop = train.stops.find(s => s.stn === TARGET);

      results.push({
        trainNo: train.no,
        trainType: train.type,
        dir: train.dir,
        from: train.from,
        to: train.to,
        isDirectStop: !!directStop,
        directStopTime: directStop ? (directStop.dep || directStop.arr) : null,
        estimatedPassTime: estTime,
        prevStation: prev.stn,
        prevTime: prev.t,
        prevKm: prev.km,
        nextStation: next.stn,
        nextTime: next.t,
        nextKm: next.km,
        ratio: Math.round(ratio * 100) / 100,
      });
    }

    results.sort((a, b) => a.estimatedPassTime.localeCompare(b.estimatedPassTime));
    res.json({ source: gttCache?.source, date: gttCache?.date, target: TARGET, count: results.length, results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.listen(PORT, () => {
  console.log(`Railshot server on port ${PORT}`);
  // 啟動時預先建立索引
  buildIndex().catch(e => console.error('Index build failed:', e.message));
});
