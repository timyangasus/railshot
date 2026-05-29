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

async function tdxWithRetry(urlPath, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const token = await getToken();
      const res = await fetch(`https://tdx.transportdata.tw${urlPath}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 429) {
        if (i < retries) { await new Promise(r => setTimeout(r, 2000)); continue; }
        throw new Error('TDX 429: 請求過於頻繁，請稍後再試');
      }
      if (!res.ok) throw new Error(`TDX ${res.status}: ${urlPath}`);
      return res.json();
    } catch (e) {
      if (i === retries) throw e;
    }
  }
}

// ── Station cache (name→id, id→mileage) ─────────────
let stationCache = null;    // { '臺北': '1000', ... }
let stationMileage = null;  // { '1000': 0.0, '1010': 3.5, ... } km from start
let stationOrder = null;    // ['1000','1010',...] ordered by mileage

async function buildStationData() {
  if (stationCache) return;
  const data = await tdxWithRetry('/api/basic/v3/Rail/TRA/Station?$format=JSON');
  let stations = Array.isArray(data) ? data
    : Array.isArray(data.Stations) ? data.Stations
    : Array.isArray(data.value) ? data.value : [];

  stationCache = {};
  stationMileage = {};

  stations.forEach(s => {
    const zhName = (s.StationName?.Zh_tw || s.StationName?.ZhTw ||
      (typeof s.StationName === 'string' ? s.StationName : '') || '').trim();
    const id = String(s.StationID || s.StationId || s.StationCode || '').trim();
    const km = parseFloat(s.StationPosition?.GeoDecimalDegree?.Mileage
      || s.Mileage || s.CumulativeDistance || 0);
    if (zhName && id) {
      stationCache[zhName] = id;
      stationMileage[id] = km;
    }
  });

  // Order stations by mileage
  stationOrder = Object.entries(stationMileage)
    .sort((a, b) => a[1] - b[1])
    .map(e => e[0]);

  console.log(`Loaded ${Object.keys(stationCache).length} stations`);
}

async function resolveStationId(name) {
  if (/^\d+$/.test(name)) return name;
  await buildStationData();
  if (stationCache[name]) return stationCache[name];
  const alt = name.replace(/^台/, '臺').replace(/^臺/, '台');
  if (stationCache[alt]) return stationCache[alt];
  console.warn(`Station not found: "${name}"`);
  return name;
}

// ── Time helpers ────────────────────────────────────
function timeToMins(t) {
  if (!t || t === '??:??') return -1;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minsToTime(m) {
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

// ── Train type from TDX ─────────────────────────────
function getTrainType(info) {
  const code = String(info.TrainTypeCode || '3');
  const name = (info.TrainTypeName?.Zh_tw || '');
  if (name.includes('普悠瑪')) return 'puy';
  if (name.includes('太魯閣')) return 'tze';
  if (name.includes('EMU3000') || name.includes('3000')) return 'exp3';
  if (name.includes('莒光')) return 'moc';
  if (name.includes('區間快')) return 'localx';
  if (name.includes('區間')) return 'local';
  const map = {'1':'tze','2':'puy','3':'exp','4':'exp','5':'exp3',
    '6':'local','7':'localx','8':'moc','9':'moc','10':'localx','11':'exp3','12':'local'};
  return map[code] || 'exp';
}

// ── Core: query all trains passing between two stations ──
// GET /api/between/:s1/:s2/:date?start=HH:MM&mins=30
app.get('/api/between/:s1/:s2/:date', async (req, res) => {
  try {
    const { s1, s2, date } = req.params;
    const startTime = req.query.start || '00:00';   // HH:MM
    const rangeMin = parseInt(req.query.mins || '30');
    const dirFilter = req.query.dir || 'all'; // 'all','up','down'

    const id1 = await resolveStationId(decodeURIComponent(s1));
    const id2 = await resolveStationId(decodeURIComponent(s2));
    console.log(`Between query: ${s1}(${id1}) ↔ ${s2}(${id2}) on ${date} from ${startTime} +${rangeMin}min`);

    const startMins = timeToMins(startTime);
    const endMins = startMins + rangeMin;

    // 1. Get live delay map
    let liveMap = {};
    try {
      const liveData = await tdxWithRetry('/api/basic/v3/Rail/TRA/TrainLiveBoard?$format=JSON&$top=500');
      (liveData.TrainLiveBoards || liveData || []).forEach(t => {
        liveMap[t.TrainNo] = t.DelayTime || 0;
      });
    } catch(e) { console.log('Live data unavailable'); }

    // 2. Get full timetable for the date (all trains)
    // Use station-based query for s1 to get all passing trains
    const [data1, data2] = await Promise.all([
      tdxWithRetry(`/api/basic/v3/Rail/TRA/DailyTrainTimetable/Station/${id1}/${date}?$format=JSON`),
      tdxWithRetry(`/api/basic/v3/Rail/TRA/DailyTrainTimetable/Station/${id2}/${date}?$format=JSON`)
    ]);

    // Build set of train numbers from both stations
    const trains1 = new Map(); // trainNo → timetable
    const trains2 = new Map();

    (data1.TrainTimetables || []).forEach(tt => {
      trains1.set(tt.TrainInfo?.TrainNo, tt);
    });
    (data2.TrainTimetables || []).forEach(tt => {
      trains2.set(tt.TrainInfo?.TrainNo, tt);
    });

    // 3. For trains stopping at BOTH stations → use actual times
    // For trains stopping at only ONE of the two → estimate pass time
    // We need to find all trains that pass through the s1↔s2 segment

    // Get mileage positions
    const km1 = stationMileage[id1] || 0;
    const km2 = stationMileage[id2] || 0;
    const segStart = Math.min(km1, km2);
    const segEnd = Math.max(km1, km2);

    const results = [];

    // Collect all train numbers from either station
    const allTrainNos = new Set([...trains1.keys(), ...trains2.keys()]);

    for (const trainNo of allTrainNos) {
      const tt1 = trains1.get(trainNo);
      const tt2 = trains2.get(trainNo);
      const tt = tt1 || tt2;
      const info = tt.TrainInfo || {};

      const delay = liveMap[trainNo] || 0;
      const trainType = getTrainType(info);
      const direction = info.Direction; // 0=down, 1=up
      const dirStr = direction === 0 ? 'down' : 'up';

      // Direction filter
      if (dirFilter !== 'all' && dirStr !== dirFilter) continue;

      const stops = tt.StopTimes || [];

      // Find stop times at s1 and s2
      const stop1 = stops.find(s => String(s.StationID) === String(id1));
      const stop2 = stops.find(s => String(s.StationID) === String(id2));

      let passTime1, passTime2, isEstimated;

      if (stop1 && stop2) {
        // Both stations are stops → actual times
        passTime1 = stop1.ArrivalTime || stop1.DepartureTime;
        passTime2 = stop2.ArrivalTime || stop2.DepartureTime;
        isEstimated = false;
      } else if (stop1 && !stop2) {
        // Only s1 is a stop → estimate s2 from adjacent stops
        passTime1 = stop1.ArrivalTime || stop1.DepartureTime;
        passTime2 = estimatePassTime(stops, id2, km2, delay);
        isEstimated = true;
      } else if (!stop1 && stop2) {
        // Only s2 is a stop → estimate s1 from adjacent stops
        passTime1 = estimatePassTime(stops, id1, km1, delay);
        passTime2 = stop2.ArrivalTime || stop2.DepartureTime;
        isEstimated = true;
      } else {
        // Neither station is a stop → estimate both
        passTime1 = estimatePassTime(stops, id1, km1, delay);
        passTime2 = estimatePassTime(stops, id2, km2, delay);
        isEstimated = true;
      }

      if (!passTime1) continue;

      // Check if train actually passes through the segment
      // by verifying it has stops on BOTH sides of the segment
      const stopKms = stops.map(s => stationMileage[String(s.StationID)] || null).filter(k => k !== null);
      const minStopKm = Math.min(...stopKms);
      const maxStopKm = Math.max(...stopKms);
      if (maxStopKm < segStart || minStopKm > segEnd) continue; // doesn't pass through

      // Check time window
      const pass1Mins = timeToMins(passTime1) + (isEstimated ? delay : 0);
      if (pass1Mins < 0 || pass1Mins < startMins || pass1Mins > endMins) continue;

      // Determine which station is "first" based on direction
      const s1IsFirst = direction === 0
        ? (km1 <= km2)   // down: smaller km first
        : (km1 >= km2);  // up: larger km first

      results.push({
        trainNo,
        trainType,
        direction: dirStr,
        fromStation: (info.StartingStationName?.Zh_tw || ''),
        toStation: (info.EndingStationName?.Zh_tw || ''),
        s1Name: decodeURIComponent(s1),
        s2Name: decodeURIComponent(s2),
        s1Time: passTime1,
        s2Time: passTime2,
        s1Delay: isEstimated ? 0 : delay,
        s2Delay: isEstimated ? 0 : delay,
        delayMin: delay,
        isEstimated,
        passTimeMins: pass1Mins, // for sorting
      });
    }

    // Sort by pass time at s1
    results.sort((a, b) => a.passTimeMins - b.passTimeMins);

    console.log(`Between result: ${results.length} trains (${results.filter(r=>!r.isEstimated).length} actual, ${results.filter(r=>r.isEstimated).length} estimated)`);
    res.json({ trains: results });

  } catch (e) {
    console.error('Between error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Estimate pass time using adjacent stops + mileage ──
function estimatePassTime(stops, targetId, targetKm, delay) {
  if (!stationMileage || targetKm === 0) return null;

  // Find adjacent stops (before and after target km)
  let prevStop = null, nextStop = null;

  for (const stop of stops) {
    const stopId = String(stop.StationID);
    const stopKm = stationMileage[stopId];
    if (stopKm === undefined) continue;

    const stopTime = stop.ArrivalTime || stop.DepartureTime;
    if (!stopTime) continue;

    if (stopKm <= targetKm) {
      if (!prevStop || stopKm > (stationMileage[String(prevStop.StationID)] || 0)) {
        prevStop = stop;
      }
    } else {
      if (!nextStop || stopKm < (stationMileage[String(nextStop.StationID)] || 0)) {
        nextStop = stop;
      }
    }
  }

  if (!prevStop || !nextStop) return null;

  const prevKm = stationMileage[String(prevStop.StationID)] || 0;
  const nextKm = stationMileage[String(nextStop.StationID)] || 0;
  const prevTime = timeToMins(prevStop.DepartureTime || prevStop.ArrivalTime);
  const nextTime = timeToMins(nextStop.ArrivalTime || nextStop.DepartureTime);

  if (nextKm === prevKm || nextTime <= prevTime) return null;

  // Linear interpolation
  const ratio = (targetKm - prevKm) / (nextKm - prevKm);
  const estimatedMins = Math.round(prevTime + ratio * (nextTime - prevTime));
  return minsToTime(estimatedMins);
}

// ── Existing endpoints ───────────────────────────────
// ── DEBUG: 驗證大湖站通過時間 ──────────────────────────
app.get('/api/debug/dahu', async (req, res) => {
  try {
    const date = new Date().toISOString().split('T')[0];
    // 直接用已知南迴/縱貫線可能的大湖站 ID 試
    // 台鐵站 ID 格式：4碼數字
    // 大湖（路竹區）在縱貫線，ID 可能在 4300~4400 區間
    const candidateIds = ['4340','4350','4360','4370','4380','4330','4320'];
    const results = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    for (const id of candidateIds) {
      try {
        await sleep(800);
        const data = await tdxWithRetry(
          `/api/basic/v3/Rail/TRA/DailyTrainTimetable/Station/${id}/${date}?$format=JSON&$top=2`
        );
        const tt = (data.TrainTimetables || [])[0];
        const info = tt?.TrainInfo || {};
        const stops = tt?.StopTimes || [];
        const firstStop = stops[0];
        results.push({
          id,
          success: true,
          sampleStation: firstStop?.StationName?.Zh_tw,
          trainNo: info.TrainNo,
          stopKeys: firstStop ? Object.keys(firstStop) : []
        });
      } catch(e) {
        results.push({ id, success: false, error: e.message });
      }
    }
    res.json({ date, results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/od/:from/:to/:date', async (req, res) => {
  try {
    const { from, to, date } = req.params;
    const fromId = await resolveStationId(decodeURIComponent(from));
    const toId = await resolveStationId(decodeURIComponent(to));
    console.log(`OD query: ${from}(${fromId}) → ${to}(${toId}) on ${date}`);
    const data = await tdxWithRetry(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/OD/${fromId}/to/${toId}/${date}?$format=JSON`
    );
    if (data.TrainTimetables) {
      const before = data.TrainTimetables.length;
      data.TrainTimetables = data.TrainTimetables.filter(tt => {
        const stops = tt.StopTimes || [];
        return stops.some(s => String(s.StationID) === String(fromId));
      });
      console.log(`OD filter: ${data.TrainTimetables.length}/${before} trains stop at ${from}`);
      const sample = data.TrainTimetables.slice(0,3).map(tt=>({
        no:tt.TrainInfo?.TrainNo,typeCode:tt.TrainInfo?.TrainTypeCode,
        typeName:tt.TrainInfo?.TrainTypeName?.Zh_tw
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
    const data = await tdxWithRetry(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/Station/${id}/${date}?$format=JSON`
    );
    res.json(data);
  } catch (e) {
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
    await buildStationData();
    res.json(stationCache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/train/:trainNo/:date', async (req, res) => {
  try {
    const { trainNo, date } = req.params;
    const data = await tdxWithRetry(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/TrainNo/${trainNo}/${date}?$format=JSON`
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Railshot proxy running on port ${PORT}`);
  try { await buildStationData(); }
  catch(e) { console.error('Failed to preload stations:', e.message); }
});
