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

// ── 內建台鐵里程表（km，從基隆起算） ──────────────────
// 來源：台鐵官方里程表，縱貫線 + 屏東線 + 北迴線 + 南迴線
const STATION_KM = {
  // 縱貫線（北段）
  '0900':0,    // 基隆
  '0910':3.4,  // 三坑
  '0920':6.0,  // 八堵
  '0930':7.6,  // 暖暖
  '0940':9.7,  // 四腳亭
  '1000':13.0, // 瑞芳
  '1010':16.4, // 猴硐
  '1020':19.4, // 三貂嶺
  '1030':22.0, // 大華
  '1040':24.0, // 十分
  '1050':26.0, // 望古
  '1060':27.6, // 嶺腳
  '1070':29.4, // 平溪
  '1080':32.0, // 菁桐
  // 縱貫線主線
  '1090':19.0, // 牡丹（宜蘭線）
  '1100':24.5, // 雙溪
  '1110':29.6, // 貢寮
  '1120':32.8, // 福隆
  '1130':37.5, // 石城
  '1140':40.9, // 大里
  '1150':43.0, // 大溪
  '1160':46.0, // 龜山
  '1170':50.3, // 外澳
  '1180':52.5, // 頭城
  '1190':57.9, // 頂埔
  '1200':60.4, // 礁溪
  '1210':65.0, // 四城
  '1220':67.3, // 宜蘭
  '1230':71.0, // 二結
  '1240':73.7, // 中里
  '1250':76.3, // 山腳
  '1260':79.0, // 羅東
  '1270':82.6, // 冬山
  '1280':86.5, // 新馬
  '1290':89.6, // 蘇澳新
  '1300':91.6, // 蘇澳
  // 縱貫線（台北都會）
  '1340':27.7, // 松山
  '1350':28.8, // 八德（廢）
  '1360':31.0, // 南港
  '1370':34.3, // 臺北
  '1380':36.5, // 萬華
  '1390':40.0, // 板橋
  '1400':42.5, // 浮洲
  '1410':44.3, // 樹林
  '1420':46.0, // 山佳
  '1430':48.6, // 鶯歌
  '1440':52.8, // 桃園
  '1450':55.3, // 內壢
  '1460':57.4, // 中壢
  '1470':60.0, // 埔心
  '1480':63.8, // 楊梅
  '1490':67.4, // 富岡
  '1500':71.3, // 新富岡（廢）
  '1510':73.9, // 湖口
  '1520':78.0, // 新豐
  '1530':80.8, // 竹北
  '1540':83.5, // 北新竹
  '1550':85.0, // 新竹
  '1560':87.9, // 三姓橋
  '1570':90.2, // 香山
  '1580':93.6, // 崎頂
  '1590':97.9, // 竹南
  '1600':101.3,// 談文
  '1610':104.1,// 大山
  '1620':107.3,// 後龍
  '1630':110.8,// 龍港
  '1640':113.0,// 白沙屯
  '1650':116.0,// 新埔
  '1660':119.6,// 通霄
  '1670':124.0,// 苑裡
  '1680':128.0,// 日南
  '1690':131.4,// 大甲
  '1700':135.5,// 台中港（廢）
  '1710':138.0,// 清水
  '1720':141.4,// 沙鹿
  '1730':143.8,// 龍井
  '1740':146.9,// 大肚
  '2000':149.3,// 追分
  '2010':154.1,// 烏日
  '2020':156.2,// 新烏日
  '2030':159.0,// 成功
  '2040':161.2,// 大慶
  '2050':163.8,// 臺中
  '2060':165.6,// 精武
  '2070':168.0,// 太原
  '2080':169.8,// 頭家厝
  '2090':171.9,// 松竹
  '2100':174.2,// 潭子
  '2110':176.7,// 栗林
  '2120':179.2,// 豐原
  '2130':181.8,// 后里
  '2140':185.8,// 泰安
  '2150':189.6,// 苗栗
  '2160':192.2,// 南勢
  '2170':195.5,// 銅鑼
  '2180':199.3,// 三義
  '2190':204.5,// 泰安舊站（廢）
  '2200':207.0,// 后里（舊）
  '3000':171.5,// 彰化（從追分算）
  // 縱貫線（彰化以南）
  '3010':174.8,// 花壇
  '3020':178.2,// 大村
  '3030':180.8,// 員林
  '3040':183.9,// 永靖
  '3050':186.1,// 社頭
  '3060':188.4,// 田中
  '3070':191.8,// 二水
  '3080':196.9,// 林內
  '3090':199.2,// 石榴
  '3100':201.5,// 斗六
  '3110':204.8,// 斗南
  '3120':208.6,// 石龜
  '3130':210.6,// 大林
  '3140':213.4,// 民雄
  '3150':215.9,// 北回歸線
  '3160':217.8,// 嘉義
  '4080':217.8,// 嘉義（同上）
  '4090':221.2,// 水上
  '4100':224.1,// 南靖
  '4110':226.5,// 後壁
  '4120':229.4,// 新營
  '4130':232.2,// 柳營
  '4140':234.8,// 林鳳營
  '4150':237.5,// 隆田
  '4160':240.0,// 拔林
  '4170':242.5,// 善化
  '4180':244.7,// 南科
  '4190':247.0,// 新市
  '4200':249.8,// 永康
  '4210':252.6,// 大橋
  '4220':255.5,// 臺南
  '1370':255.5,// 臺南（同 4220）
  '4230':258.2,// 保安
  '4240':260.8,// 仁德
  '4250':263.0,// 中洲
  '4260':265.2,// 大湖
  '4290':265.2,// 大湖（確認 ID）
  '4270':267.5,// 路竹
  '4280':269.8,// 岡山
  '4310':269.8,// 岡山（確認 ID）
  '4320':272.8,// 橋頭
  '4330':275.5,// 楠梓
  '4340':278.5,// 新左營
  '4350':282.0,// 左營
  '4360':283.5,// 內惟
  '4370':285.0,// 美術館
  '4380':286.8,// 鼓山
  '4390':288.0,// 三塊厝
  '4400':289.5,// 高雄
  '4410':291.2,// 民族
  '4420':292.8,// 科工館
  '4430':294.0,// 正義
  '4440':295.2,// 鳳山
  '4450':297.0,// 鳳山（新）
  '4460':299.5,// 九曲堂
  '4470':301.5,// 六塊厝
  '5000':304.5,// 屏東
  '5010':308.2,// 歸來
  '5020':311.0,// 麟洛
  '5030':314.5,// 西勢
  '5040':317.0,// 竹田
  '5050':320.0,// 潮州
  '5060':323.5,// 崁頂
  '5070':326.8,// 南州
  '5080':330.5,// 鎮安
  '5090':333.0,// 林邊
  '5100':335.5,// 佳冬
  '5110':338.0,// 東海
  '5120':340.5,// 枋寮
};

// ── Station name→ID cache（只從 TDX 查名稱，不查里程） ──
let stationCache = null;

async function buildStationData() {
  if (stationCache) return;
  const data = await tdxWithRetry('/api/basic/v3/Rail/TRA/Station?$format=JSON');
  let stations = Array.isArray(data) ? data
    : Array.isArray(data.Stations) ? data.Stations
    : Array.isArray(data.value) ? data.value : [];

  stationCache = {};
  stations.forEach(s => {
    const zhName = (s.StationName?.Zh_tw || '').trim();
    const id = String(s.StationID || '').trim();
    if (zhName && id) stationCache[zhName] = id;
  });
  console.log(`Loaded ${Object.keys(stationCache).length} station names`);
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

// ── Time helpers ─────────────────────────────────────
function timeToMins(t) {
  if (!t || t === '??:??') return -1;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minsToTime(m) {
  const h = Math.floor(((m % 1440) + 1440) % 1440 / 60);
  const min = ((m % 1440) + 1440) % 1440 % 60;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

// ── Train type ────────────────────────────────────────
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

// ── 里程插值推算通過時間 ──────────────────────────────
// stops: StopTimes 陣列
// targetId: 目標站 StationID
// 回傳 HH:MM 或 null
function estimatePassTime(stops, targetId) {
  const targetKm = STATION_KM[String(targetId)];
  if (targetKm === undefined) return null;

  let prev = null, next = null;

  for (const stop of stops) {
    const stopId = String(stop.StationID);
    const km = STATION_KM[stopId];
    if (km === undefined) continue;
    const t = stop.DepartureTime || stop.ArrivalTime;
    if (!t) continue;

    if (km <= targetKm) {
      if (!prev || km > STATION_KM[String(prev.StationID)]) prev = stop;
    } else {
      if (!next || km < STATION_KM[String(next.StationID)]) next = stop;
    }
  }

  if (!prev || !next) return null;

  const prevKm = STATION_KM[String(prev.StationID)];
  const nextKm = STATION_KM[String(next.StationID)];
  const prevMins = timeToMins(prev.DepartureTime || prev.ArrivalTime);
  const nextMins = timeToMins(next.ArrivalTime || next.DepartureTime);

  if (nextKm === prevKm || nextMins <= prevMins) return null;

  const ratio = (targetKm - prevKm) / (nextKm - prevKm);
  return minsToTime(Math.round(prevMins + ratio * (nextMins - prevMins)));
}

// ── /api/between：兩站間所有列車（含過路車） ───────────
app.get('/api/between/:s1/:s2/:date', async (req, res) => {
  try {
    const { s1, s2, date } = req.params;
    const startTime = req.query.start || '00:00';
    const rangeMin = parseInt(req.query.mins || '30');
    const dirFilter = req.query.dir || 'all';

    const id1 = await resolveStationId(decodeURIComponent(s1));
    const id2 = await resolveStationId(decodeURIComponent(s2));
    const km1 = STATION_KM[id1];
    const km2 = STATION_KM[id2];

    console.log(`Between: ${s1}(${id1},${km1}km) ↔ ${s2}(${id2},${km2}km) on ${date} from ${startTime}+${rangeMin}min`);

    if (km1 === undefined || km2 === undefined) {
      return res.status(400).json({ error: `里程表找不到站: ${km1===undefined?s1:s2}` });
    }

    const startMins = timeToMins(startTime);
    const endMins = startMins + rangeMin;
    const segMin = Math.min(km1, km2);
    const segMax = Math.max(km1, km2);

    // 即時誤點
    let liveMap = {};
    try {
      const liveData = await tdxWithRetry('/api/basic/v3/Rail/TRA/TrainLiveBoard?$format=JSON&$top=500');
      (liveData.TrainLiveBoards || liveData || []).forEach(t => {
        liveMap[t.TrainNo] = t.DelayTime || 0;
      });
    } catch(e) { console.log('Live unavailable'); }

    // 查兩站各自的時刻表，取所有經過列車
    const [data1, data2] = await Promise.all([
      tdxWithRetry(`/api/basic/v3/Rail/TRA/DailyTrainTimetable/Station/${id1}/${date}?$format=JSON`),
      tdxWithRetry(`/api/basic/v3/Rail/TRA/DailyTrainTimetable/Station/${id2}/${date}?$format=JSON`)
    ]);

    // 合併兩站的列車，建立 trainNo → timetable 的 Map
    const trainMap = new Map();
    for (const tt of [...(data1.TrainTimetables||[]), ...(data2.TrainTimetables||[])]) {
      const no = tt.TrainInfo?.TrainNo;
      if (no && !trainMap.has(no)) trainMap.set(no, tt);
    }

    const results = [];

    for (const [trainNo, tt] of trainMap) {
      const info = tt.TrainInfo || {};
      const stops = tt.StopTimes || [];
      const delay = liveMap[trainNo] || 0;
      const trainType = getTrainType(info);
      const dir = info.Direction === 0 ? 'down' : 'up';

      if (dirFilter !== 'all' && dir !== dirFilter) continue;

      // 確認此列車確實通過這段區間
      // 方法：找此車所有已知停靠站的里程，確認有在 s1 之前和 s2 之後的站
      const stopKms = stops.map(s => STATION_KM[String(s.StationID)]).filter(k => k !== undefined);
      if (!stopKms.length) continue;
      const minKm = Math.min(...stopKms);
      const maxKm = Math.max(...stopKms);
      if (maxKm < segMin || minKm > segMax) continue; // 不通過此區間

      // 找 s1 和 s2 的時間
      const stop1 = stops.find(s => String(s.StationID) === String(id1));
      const stop2 = stops.find(s => String(s.StationID) === String(id2));

      let time1, time2, isEstimated;

      if (stop1 && stop2) {
        time1 = stop1.ArrivalTime || stop1.DepartureTime;
        time2 = stop2.ArrivalTime || stop2.DepartureTime;
        isEstimated = false;
      } else if (stop1) {
        time1 = stop1.ArrivalTime || stop1.DepartureTime;
        time2 = estimatePassTime(stops, id2);
        isEstimated = true;
      } else if (stop2) {
        time1 = estimatePassTime(stops, id1);
        time2 = stop2.ArrivalTime || stop2.DepartureTime;
        isEstimated = true;
      } else {
        time1 = estimatePassTime(stops, id1);
        time2 = estimatePassTime(stops, id2);
        isEstimated = true;
      }

      if (!time1) continue;

      // 時間窗口篩選（加上誤點）
      const pass1Mins = timeToMins(time1) + delay;
      if (pass1Mins < startMins || pass1Mins > endMins) continue;

      results.push({
        trainNo,
        trainType,
        direction: dir,
        fromStation: info.StartingStationName?.Zh_tw || '',
        toStation: info.EndingStationName?.Zh_tw || '',
        s1Time: time1,
        s2Time: time2 || '--',
        delayMin: delay,
        isEstimated,
        passTimeMins: pass1Mins,
      });
    }

    results.sort((a, b) => a.passTimeMins - b.passTimeMins);
    const actualCount = results.filter(r => !r.isEstimated).length;
    const estimatedCount = results.filter(r => r.isEstimated).length;
    console.log(`Between result: ${results.length} trains (actual:${actualCount} estimated:${estimatedCount})`);
    res.json({ trains: results });

  } catch(e) {
    console.error('Between error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DEBUG ─────────────────────────────────────────────
app.get('/api/debug/dahu', async (req, res) => {
  try {
    // 只查一班，看里程推算是否正確
    // 108 自強：有停岡山、臺南，大湖在中間，應推算約 06:30
    const data = await tdxWithRetry(
      `/api/basic/v3/Rail/TRA/GeneralTrainTimetable/TrainNo/108?$format=JSON`
    );
    const tt = (data.TrainTimetables || [])[0];
    const stops = tt?.StopTimes || [];
    const dahuId = '4290';
    const dahuStop = stops.find(s => String(s.StationID) === dahuId);
    const estimated = estimatePassTime(stops, dahuId);
    // 找前後停靠站
    const dahuKm = STATION_KM[dahuId];
    const prevStop = stops.filter(s => (STATION_KM[String(s.StationID)]||999) < dahuKm).slice(-1)[0];
    const nextStop = stops.find(s => (STATION_KM[String(s.StationID)]||0) > dahuKm);
    res.json({
      trainNo: tt?.TrainInfo?.TrainNo,
      type: tt?.TrainInfo?.TrainTypeName?.Zh_tw,
      totalStops: stops.length,
      dahuKm,
      dahuInStopTimes: !!dahuStop,
      prevStop: prevStop ? { id: prevStop.StationID, name: prevStop.StationName?.Zh_tw, dep: prevStop.DepartureTime, km: STATION_KM[String(prevStop.StationID)] } : null,
      nextStop: nextStop ? { id: nextStop.StationID, name: nextStop.StationName?.Zh_tw, arr: nextStop.ArrivalTime, km: STATION_KM[String(nextStop.StationID)] } : null,
      estimatedPassTime: estimated,
      officialWebsite: '(06:31)',
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 其他 API 端點 ─────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/od/:from/:to/:date', async (req, res) => {
  try {
    const { from, to, date } = req.params;
    const fromId = await resolveStationId(decodeURIComponent(from));
    const toId = await resolveStationId(decodeURIComponent(to));
    console.log(`OD: ${from}(${fromId}) → ${to}(${toId}) on ${date}`);
    const data = await tdxWithRetry(
      `/api/basic/v3/Rail/TRA/DailyTrainTimetable/OD/${fromId}/to/${toId}/${date}?$format=JSON`
    );
    if (data.TrainTimetables) {
      data.TrainTimetables = data.TrainTimetables.filter(tt =>
        (tt.StopTimes||[]).some(s => String(s.StationID) === String(fromId))
      );
      const sample = data.TrainTimetables.slice(0,3).map(tt=>({
        no:tt.TrainInfo?.TrainNo,
        typeCode:tt.TrainInfo?.TrainTypeCode,
        typeName:tt.TrainInfo?.TrainTypeName?.Zh_tw
      }));
      console.log('Sample:', JSON.stringify(sample));
    }
    res.json(data);
  } catch(e) {
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
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/live', async (req, res) => {
  try {
    const data = await tdxWithRetry('/api/basic/v3/Rail/TRA/TrainLiveBoard?$format=JSON&$top=500');
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stations', async (req, res) => {
  try {
    await buildStationData();
    res.json(stationCache);
  } catch(e) {
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
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Railshot proxy running on port ${PORT}`);
});
