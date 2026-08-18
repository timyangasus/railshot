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

// TDX 平時回應很快，但流量暴增時（例如颱風天大家瘋狂查班次）可能整個卡住不回應，
// fetch 本身沒有內建逾時，一定要自己加 AbortController，否則請求可能無限期掛著。
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetchWithTimeout(
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
      const res = await fetchWithTimeout(`https://tdx.transportdata.tw${urlPath}`, {
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

// ── Timetable cache & index (多日期快取) ───────────────
// gttCacheMap: { '2026-07-01': { trains, trainIndex, stationIndex, builtAt, source } }
const gttCacheMap = {};
const CACHE_TTL = 20 * 60 * 60 * 1000; // 20hr
const MAX_CACHED_DATES = 5; // 最多同時快取幾天，避免記憶體無限增長

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function isValidDateStr(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function pruneCacheIfNeeded() {
  const keys = Object.keys(gttCacheMap);
  if (keys.length <= MAX_CACHED_DATES) return;
  // 移除最舊建立的快取
  keys.sort((a, b) => gttCacheMap[a].builtAt - gttCacheMap[b].builtAt);
  delete gttCacheMap[keys[0]];
}

async function buildIndex(dateStr) {
  const date = isValidDateStr(dateStr) ? dateStr : todayStr();
  const cached = gttCacheMap[date];
  if (cached && Date.now() - cached.builtAt < CACHE_TTL) return cached;

  console.log(`Building timetable index for ${date}...`);

  let timetables = [];
  let source = '';
  try {
    const data = await tdxFetch(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${date}?$format=JSON`
    );
    timetables = data.TrainTimetables || data || [];
    source = 'DailyTrainTimetable';
    console.log(`DailyTrainTimetable[${date}]: ${timetables.length} trains`);
  } catch(e) {
    console.warn(`DailyTrainTimetable[${date}] failed (${e.message}), fallback to GeneralTrainTimetable`);
    const data = await tdxFetch('/api/basic/v3/Rail/TRA/GeneralTrainTimetable?$format=JSON');
    timetables = data.TrainTimetables || data || [];
    source = 'GeneralTrainTimetable(fallback)';
    console.log(`GeneralTrainTimetable fallback: ${timetables.length} trains`);
  }

  const trainIndex = {};
  const stationIndex = {};
  const trains = [];

  for (const tt of timetables) {
    const info = tt.TrainInfo || {};
    const rawStops = tt.StopTimes || [];

    const trainNo = String(info.TrainNo || '');
    const type = getTrainType(info);
    // TDX Direction: 0=上行(北上/往基隆), 1=下行(南下/往屏東)
    const dir = info.Direction === 0 ? 'up' : 'down';
    const from = info.StartingStationName?.Zh_tw || '';
    const to   = info.EndingStationName?.Zh_tw   || '';
    const suspended = info.SuspendedFlag === 1;
    // DailyFlag: 1=每日行駛, 0=特定日期才行駛（實際規律通常寫在 Note，例如「逢週五行駛」）
    const dailyFlag = info.DailyFlag === 1;
    const note = info.Note || '';

    const stops = rawStops
      .sort((a, b) => a.StopSequence - b.StopSequence)
      .map(s => ({
        id:  String(s.StationID || ''),
        stn: s.StationName?.Zh_tw || '',
        arr: s.ArrivalTime   || '',
        dep: s.DepartureTime || '',
        suspended: s.SuspendedFlag === 1,
      }));

    const trainData = { no: trainNo, type, dir, from, to, stops, suspended, dailyFlag, note };
    trainIndex[trainNo] = trainData;
    trains.push(trainData);

    // ── stationIndex ───────────────────────────────────
    for (const stop of stops) {
      if (!stop.stn) continue;
      if (!stationIndex[stop.stn]) stationIndex[stop.stn] = [];
      stationIndex[stop.stn].push({
        no: trainNo, type, dir, from, to,
        time: stop.dep || stop.arr,
        suspended: suspended || stop.suspended,
      });
    }

    // stopSet：O(1) 判斷列車是否停靠某站（兩站之間查詢用）
    trainData.stopSet = new Set(stops.map(s => s.stn).filter(Boolean));
  }

  console.log(`Index built [${source}] for ${date}: ${trains.length} trains, ${Object.keys(stationIndex).length} stations`);

  const entry = { trains, trainIndex, stationIndex, builtAt: Date.now(), date, source };
  gttCacheMap[date] = entry;
  pruneCacheIfNeeded();
  return entry;
}

// ── 一般時刻表（不綁定日期，查車次用）───────────────────
// GeneralTrainTimetable 代表車次的「一般規律班表」，不受特定某天停駛/加班影響，
// 車次找不到當天資料時（例如選錯日期，或該日剛好不開）可以退而求其次用這份查基本資訊。
let generalIndexCache = null;
const GENERAL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24hr

async function buildGeneralIndex() {
  if (generalIndexCache && Date.now() - generalIndexCache.builtAt < GENERAL_CACHE_TTL) return generalIndexCache;

  console.log('Building general timetable index...');
  const data = await tdxFetch('/api/basic/v3/Rail/TRA/GeneralTrainTimetable?$format=JSON');
  const timetables = data.TrainTimetables || data || [];

  const trainIndex = {};
  for (const tt of timetables) {
    const info = tt.TrainInfo || {};
    const rawStops = tt.StopTimes || [];
    const trainNo = String(info.TrainNo || '');
    const stops = rawStops
      .sort((a, b) => a.StopSequence - b.StopSequence)
      .map(s => ({
        id: String(s.StationID || ''),
        stn: s.StationName?.Zh_tw || '',
        arr: s.ArrivalTime || '',
        dep: s.DepartureTime || '',
      }));
    trainIndex[trainNo] = {
      no: trainNo,
      type: getTrainType(info),
      dir: info.Direction === 0 ? 'up' : 'down',
      from: info.StartingStationName?.Zh_tw || '',
      to: info.EndingStationName?.Zh_tw || '',
      dailyFlag: info.DailyFlag === 1,
      note: info.Note || '',
      stops,
    };
  }

  console.log(`General index built: ${Object.keys(trainIndex).length} trains`);
  generalIndexCache = { trainIndex, builtAt: Date.now() };
  return generalIndexCache;
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
  const dates = Object.keys(gttCacheMap);
  const today = todayStr();
  const todayEntry = gttCacheMap[today];
  res.json({
    ok: true,
    today,
    indexed: !!todayEntry,
    cachedDates: dates,
    source: todayEntry?.source || null,
    trains: todayEntry ? todayEntry.trains.length : 0,
    stations: todayEntry ? Object.keys(todayEntry.stationIndex).length : 0,
    builtAt: todayEntry ? new Date(todayEntry.builtAt).toISOString() : null,
  });
});

// ── 全量時刻資料（前端用）────────────────────────────
app.get('/api/timetable', async (req, res) => {
  try {
    const date = req.query.date; // 可選，預設今天
    const entry = await buildIndex(date);
    res.json({ trains: entry.trains, date: entry.date, source: entry.source, builtAt: entry.builtAt });
  } catch(e) {
    console.error('timetable error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 單站查詢（server 側過濾，備用）──────────────────
app.get('/api/station/:name', async (req, res) => {
  try {
    const date = req.query.date;
    const entry = await buildIndex(date);
    const name = decodeURIComponent(req.params.name);
    const list = entry.stationIndex[name] || entry.stationIndex[name.replace(/台/g,'臺')] || [];
    res.json({ station: name, date: entry.date, trains: list });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 列車詳細（by trainNo）────────────────────────────
app.get('/api/train/:no', async (req, res) => {
  try {
    const date = req.query.date;
    const entry = await buildIndex(date);
    const no = req.params.no;
    const train = entry.trainIndex[no];
    if (!train) return res.status(404).json({ error: 'Train not found' });
    // 疊加誤點
    const liveMap = await getLiveMap();
    res.json({ ...train, date: entry.date, delay: liveMap[no] || 0 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 列車詳細（by trainNo + 指定日期，路徑版）─────────
app.get('/api/train/:no/:date', async (req, res) => {
  try {
    const { no, date } = req.params;
    const entry = await buildIndex(date);
    const train = entry.trainIndex[no];
    if (!train) return res.status(404).json({ error: 'Train not found' });
    const liveMap = await getLiveMap();
    res.json({ ...train, date: entry.date, delay: liveMap[no] || 0 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 列車詳細（一般時刻表，不綁定日期，查車次找不到當天資料時用）─
app.get('/api/train-general/:no', async (req, res) => {
  try {
    const entry = await buildGeneralIndex();
    const train = entry.trainIndex[req.params.no];
    if (!train) return res.status(404).json({ error: 'Train not found' });
    res.json(train);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TEMP DEBUG：列出所有不重複的車種名稱（找特殊主題列車用，確認後會移除）
app.get('/api/debug/train-types', async (req, res) => {
  try {
    const date = req.query.date || todayStr();
    const data = await tdxFetch(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${date}?$format=JSON`
    );
    const timetables = data.TrainTimetables || data || [];
    const seen = {};
    for (const tt of timetables) {
      const info = tt.TrainInfo || {};
      const key = `${info.TrainTypeID}|${info.TrainTypeCode}|${info.TrainTypeName?.Zh_tw}`;
      if (!seen[key]) seen[key] = { TrainTypeID: info.TrainTypeID, TrainTypeCode: info.TrainTypeCode, TrainTypeName: info.TrainTypeName?.Zh_tw, sample: info.TrainNo };
    }
    res.json({ date, count: timetables.length, types: Object.values(seen) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 時刻表 OD（時刻表 tab 用）────────────────────────
app.get('/api/od/:from/:to/:date', async (req, res) => {
  try {
    const { from, to, date } = req.params;

    const entry = await buildIndex(date);
    const fromName = decodeURIComponent(from);
    const toName   = decodeURIComponent(to);

    const results = [];
    for (const train of entry.trains) {
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
        suspended: train.suspended || depStop.suspended || arrStop.suspended,
      });
    }
    results.sort((a, b) => a.dep.localeCompare(b.dep));

    const liveMap = await getLiveMap();
    results.forEach(r => { r.delay = liveMap[r.no] || 0; });

    res.json({ from: fromName, to: toName, date: entry.date, trains: results });
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
    const date = req.query.date;
    const entry = await buildIndex(date);
    res.json(Object.keys(entry.stationIndex).sort());
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────
app.get('/api/debug/train/:no', async (req, res) => {
  try {
    const date = req.query.date;
    const entry = await buildIndex(date);
    const no = req.params.no;
    const train = entry.trainIndex[no];
    if (!train) return res.json({ found: false, no, source: entry.source, date: entry.date });
    res.json({ found: true, source: entry.source, date: entry.date, train });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug: 竹北通過列車清單（含估算細節）─────────────
app.get('/api/debug/zhubei', async (req, res) => {
  try {
    const date = req.query.date;
    const entry = await buildIndex(date);
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
    for (const train of entry.trains) {
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
    res.json({ source: entry.source, date: entry.date, target: TARGET, count: results.length, results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.listen(PORT, () => {
  console.log(`Railshot server on port ${PORT}`);
  // 啟動時預先建立索引
  buildIndex().catch(e => console.error('Index build failed:', e.message));
});
