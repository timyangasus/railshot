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

// ── Live data cache (60s) ─────────────────────────────
let liveCache = null;
let liveCacheExpiry = 0;

async function getLiveMap() {
  if (liveCache && Date.now() < liveCacheExpiry) return liveCache;
  try {
    const data = await tdxWithRetry('/api/basic/v3/Rail/TRA/TrainLiveBoard?$format=JSON&$top=500');
    const map = {};
    (data.TrainLiveBoards || data || []).forEach(t => {
      map[t.TrainNo] = t.DelayTime || 0;
    });
    liveCache = map;
    liveCacheExpiry = Date.now() + 60000;
    return map;
  } catch(e) {
    console.log('Live unavailable');
    return liveCache || {};
  }
}

// ── Station timetable cache (10 min per station per date) ──
const stationTTCache = new Map();

async function getStationTimetable(stationId, date) {
  const key = `${stationId}:${date}`;
  if (stationTTCache.has(key)) return stationTTCache.get(key);
  const data = await tdxWithRetry(
    `/api/basic/v3/Rail/TRA/DailyTrainTimetable/Station/${stationId}/${date}?$format=JSON`
  );
  stationTTCache.set(key, data);
  // 10分後清除
  setTimeout(() => stationTTCache.delete(key), 10 * 60 * 1000);
  return data;
}

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

// ── 內建台鐵里程表（km，從基隆起算，key = TDX StationID）──
const STATION_KM = {
  // 縱貫線北段（基隆→竹南）
  '0900':0,    // 基隆
  '0910':3.4,  // 三坑
  '0920':6.0,  // 八堵
  '0930':7.6,  // 七堵
  '0940':9.2,  // 百福
  '0950':11.0, // 五堵
  '0960':13.0, // 汐止
  '0970':14.5, // 汐科
  '0980':19.0, // 南港
  '0990':21.4, // 松山
  '1000':27.7, // 臺北
  '1010':29.5, // 萬華
  '1020':33.2, // 板橋
  '1030':34.9, // 浮洲
  '1040':37.0, // 樹林
  '1050':38.4, // 南樹林
  '1060':39.8, // 山佳
  '1070':42.4, // 鶯歌
  '1075':44.0, // 鳳鳴
  '1080':47.4, // 桃園
  '1090':50.0, // 內壢
  '1100':52.6, // 中壢
  '1110':55.4, // 埔心
  '1120':59.2, // 楊梅
  '1130':62.8, // 富岡
  '1140':65.0, // 新富
  '1150':68.0, // 北湖
  '1160':70.3, // 湖口
  '1170':74.0, // 新豐
  '1180':77.6, // 竹北
  '1210':80.8, // 新竹
  '1220':83.7, // 三姓橋
  '1230':86.0, // 香山
  '1240':89.5, // 崎頂
  '1250':93.0, // 竹南
  // 內灣/六家線
  '1190':78.5, // 北新竹
  '1191':79.2, // 千甲
  '1192':79.8, // 新莊
  '1193':81.5, // 竹中
  '1194':82.0, // 六家
  '1201':83.0, // 上員
  '1202':84.5, // 榮華
  '1203':87.0, // 竹東
  '1204':90.0, // 橫山
  '1205':93.5, // 九讚頭
  '1206':95.0, // 合興
  '1207':96.5, // 富貴
  '1208':99.0, // 內灣
  // 縱貫線（竹南→彰化）
  '2110':98.5,  // 談文
  '2120':101.3, // 大山
  '2130':104.5, // 後龍
  '2140':108.0, // 龍港
  '2150':111.0, // 白沙屯
  '2160':114.0, // 新埔
  '2170':117.6, // 通霄
  '2180':122.0, // 苑裡
  '2190':126.0, // 日南
  '2200':129.5, // 大甲
  '2210':132.0, // 臺中港
  '2220':135.4, // 清水
  '2230':138.8, // 沙鹿
  '2240':141.2, // 龍井
  '2250':144.3, // 大肚
  '2260':147.3, // 追分
  '3140':96.0,  // 造橋
  '3150':99.8,  // 豐富
  '3160':103.4, // 苗栗
  '3170':106.0, // 南勢
  '3180':109.3, // 銅鑼
  '3190':113.1, // 三義
  '3210':120.4, // 泰安
  '3220':124.4, // 后里
  '3230':128.4, // 豐原
  '3240':130.9, // 栗林
  '3250':133.4, // 潭子
  '3260':135.5, // 頭家厝
  '3270':137.6, // 松竹
  '3280':139.4, // 太原
  '3290':141.5, // 精武
  '3300':143.8, // 臺中
  '3310':145.6, // 五權
  '3320':147.6, // 大慶
  '3330':149.8, // 烏日
  '3340':150.9, // 新烏日
  '3350':152.7, // 成功
  '3360':156.5, // 彰化
  // 縱貫線（彰化→嘉義）
  '3370':159.8, // 花壇
  '3380':163.2, // 大村
  '3390':165.8, // 員林
  '3400':168.9, // 永靖
  '3410':171.1, // 社頭
  '3420':173.4, // 田中
  '3430':176.8, // 二水
  '3450':183.7, // 林內
  '3460':186.0, // 石榴
  '3470':188.3, // 斗六
  '3480':191.6, // 斗南
  '3490':193.6, // 石龜
  '4050':196.2, // 大林
  '4060':199.0, // 民雄
  '4070':201.5, // 嘉北
  '4080':202.6, // 嘉義
  // 集集線
  '3431':177.5, // 源泉
  '3432':179.0, // 濁水
  '3433':182.0, // 龍泉
  '3434':185.5, // 集集
  '3435':190.0, // 水里
  '3436':194.0, // 車埕
  // 縱貫線（嘉義→高雄）
  '4090':205.9, // 水上
  '4100':208.8, // 南靖
  '4110':211.2, // 後壁
  '4120':214.1, // 新營
  '4130':216.9, // 柳營
  '4140':219.5, // 林鳳營
  '4150':222.2, // 隆田
  '4160':224.7, // 拔林
  '4170':227.2, // 善化
  '4180':229.4, // 南科
  '4190':231.7, // 新市
  '4200':234.5, // 永康
  '4210':237.3, // 大橋
  '4220':240.2, // 臺南
  '4250':243.4, // 保安
  '4260':245.6, // 仁德
  '4270':247.8, // 中洲
  '4271':248.5, // 長榮大學
  '4272':249.2, // 沙崙
  '4290':252.0, // 大湖
  '4300':254.3, // 路竹
  '4310':257.1, // 岡山
  '4320':260.1, // 橋頭
  '4330':263.1, // 楠梓
  '4340':267.0, // 新左營
  '4350':268.5, // 左營
  '4360':270.0, // 內惟
  '4370':271.8, // 美術館
  '4380':273.6, // 鼓山
  '4390':274.8, // 三塊厝
  '4400':276.3, // 高雄
  '4410':278.0, // 民族
  '4420':279.6, // 科工館
  '4430':280.8, // 正義
  '4440':282.0, // 鳳山
  '4450':283.8, // 後庄
  '4460':286.3, // 九曲堂
  // 屏東線
  '4470':289.3, // 六塊厝
  '5000':292.3, // 屏東
  '5010':296.0, // 歸來
  '5020':298.8, // 麟洛
  '5030':302.3, // 西勢
  '5040':304.8, // 竹田
  '5050':307.8, // 潮州
  '5060':311.3, // 崁頂
  '5070':314.6, // 南州
  '5080':318.3, // 鎮安
  '5090':320.8, // 林邊
  '5100':323.3, // 佳冬
  '5110':325.8, // 東海
  '5120':328.3, // 枋寮
  '5130':332.0, // 加祿
  '5140':335.5, // 內獅
  '5160':339.0, // 枋山
  // 南迴線
  '5190':356.0, // 大武
  '5200':362.0, // 瀧溪
  '5210':367.0, // 金崙
  '5220':373.0, // 太麻里
  '5230':384.0, // 知本
  '5240':388.0, // 康樂
  '6000':392.0, // 臺東
  // 臺東線（臺東→花蓮）
  '6010':395.0, // 山里
  '6020':402.0, // 鹿野
  '6030':408.0, // 瑞源
  '6040':411.0, // 瑞和
  '6050':416.0, // 關山
  '6060':422.0, // 海端
  '6070':428.0, // 池上
  '6080':438.0, // 富里
  '6090':443.0, // 東竹
  '6100':447.0, // 東里
  '6110':453.0, // 玉里
  '6120':460.0, // 三民
  '6130':466.0, // 瑞穗
  '6140':472.0, // 富源
  '6150':477.0, // 大富
  '6160':481.0, // 光復
  '6170':485.0, // 萬榮
  '6180':490.0, // 鳳林
  '6190':495.0, // 南平
  '6200':498.0, // 林榮新光
  '6210':502.0, // 豐田
  '6220':508.0, // 壽豐
  '6230':512.0, // 平和
  '6240':515.0, // 志學
  '6250':517.0, // 吉安
  '7000':521.0, // 花蓮
  // 北迴線（花蓮→蘇澳新）
  '7010':524.0, // 北埔
  '7020':527.0, // 景美
  '7030':531.0, // 新城
  '7040':534.0, // 崇德
  '7050':538.0, // 和仁
  '7060':543.0, // 和平
  '7070':549.0, // 漢本
  '7080':553.0, // 武塔
  '7090':557.0, // 南澳
  '7100':562.0, // 東澳
  '7110':566.0, // 永樂
  '7120':569.0, // 蘇澳
  '7130':571.0, // 蘇澳新
  // 宜蘭線（蘇澳新→八堵）
  '7140':574.0, // 新馬
  '7150':577.0, // 冬山
  '7160':581.0, // 羅東
  '7170':584.6, // 中里
  '7180':587.3, // 二結
  '7190':589.8, // 宜蘭
  '7200':593.5, // 四城
  '7210':596.0, // 礁溪
  '7220':600.5, // 頂埔
  '7230':603.0, // 頭城
  '7240':607.0, // 外澳
  '7250':609.2, // 龜山
  '7260':611.4, // 大溪
  '7270':614.4, // 大里
  '7280':617.4, // 石城
  '7290':621.0, // 福隆
  '7300':624.0, // 貢寮
  '7310':627.0, // 雙溪
  '7320':631.0, // 牡丹
  '7330':635.0, // 三貂嶺
  '7350':641.0, // 猴硐
  '7360':645.0, // 瑞芳
  '7380':651.0, // 四腳亭
  '7390':653.5, // 暖暖
  // 平溪線
  '7331':636.0, // 大華
  '7332':638.5, // 十分
  '7333':640.0, // 望古
  '7334':641.5, // 嶺腳
  '7335':643.0, // 平溪
  '7336':646.0, // 菁桐
  // 深澳線
  '7361':646.5, // 海科館
  '7362':648.5, // 八斗子
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
// 依照 StopSequence 順序找目標站前後的停靠站，再用里程插值
function estimatePassTime(stops, targetId) {
  const targetKm = STATION_KM[String(targetId)];
  if (targetKm === undefined) return null;

  // 依 StopSequence 排序
  const sorted = [...stops].sort((a, b) => a.StopSequence - b.StopSequence);

  // 判斷行進方向：第一站到最後一站里程是增還是減
  const firstKm = STATION_KM[String(sorted[0]?.StationID)];
  const lastKm = STATION_KM[String(sorted[sorted.length-1]?.StationID)];
  const goingDown = lastKm > firstKm; // true=下行（里程增加），false=上行（里程減少）

  // 找前後相鄰的有里程資料的站
  let prev = null, next = null;

  for (const stop of sorted) {
    const km = STATION_KM[String(stop.StationID)];
    if (km === undefined) continue;
    const t = stop.DepartureTime || stop.ArrivalTime;
    if (!t) continue;

    if (goingDown) {
      if (km <= targetKm) prev = stop;
      else if (km > targetKm && !next) next = stop;
    } else {
      // 上行：里程遞減，「前一站」里程比目標大
      if (km >= targetKm) prev = stop;
      else if (km < targetKm && !next) next = stop;
    }
  }

  if (!prev || !next) return null;

  const prevKm = STATION_KM[String(prev.StationID)];
  const nextKm = STATION_KM[String(next.StationID)];
  const prevMins = timeToMins(prev.DepartureTime || prev.ArrivalTime);
  const nextMins = timeToMins(next.ArrivalTime || next.DepartureTime);

  if (prevMins < 0 || nextMins < 0) return null;

  // 里程比例插值
  const totalKmDiff = Math.abs(nextKm - prevKm);
  const targetKmDiff = Math.abs(targetKm - prevKm);
  if (totalKmDiff === 0) return null;

  const ratio = targetKmDiff / totalKmDiff;
  const timeDiff = nextMins - prevMins;
  return minsToTime(Math.round(prevMins + ratio * timeDiff));
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
    const isSameStation = id1 === id2;
    const segMin = Math.min(km1, km2);
    const segMax = Math.max(km1, km2);

    // 即時誤點（使用 cache，避免每次都打 TDX）
    const liveMap = await getLiveMap();

    // 查時刻表：同站只查一次，不同站各查一次
    let data1, data2;
    if (isSameStation) {
      data1 = await getStationTimetable(id1, date);
      data2 = data1;
    } else {
      [data1, data2] = await Promise.all([
        getStationTimetable(id1, date),
        getStationTimetable(id2, date)
      ]);
    }

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
      // 同站查詢：只要列車里程覆蓋到該站即可
      // 兩站查詢：列車里程範圍必須覆蓋整段區間
      if (isSameStation) {
        if (maxKm < km1 || minKm > km1) continue;
      } else {
        if (maxKm < segMin || minKm > segMax) continue;
      }

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
    const data = await tdxWithRetry(
      `/api/basic/v3/Rail/TRA/GeneralTrainTimetable/TrainNo/108?$format=JSON`
    );
    const tt = (data.TrainTimetables || [])[0];
    const stops = tt?.StopTimes || [];
    const sorted = [...stops].sort((a, b) => a.StopSequence - b.StopSequence);
    const dahuId = '4290';
    const dahuKm = STATION_KM[dahuId];

    // 判斷方向
    const firstKm = STATION_KM[String(sorted[0]?.StationID)];
    const lastKm = STATION_KM[String(sorted[sorted.length-1]?.StationID)];
    const goingDown = lastKm > firstKm;

    // 找前後站
    let prev = null, next = null;
    for (const stop of sorted) {
      const km = STATION_KM[String(stop.StationID)];
      if (km === undefined) continue;
      const t = stop.DepartureTime || stop.ArrivalTime;
      if (!t) continue;
      if (goingDown) {
        if (km <= dahuKm) prev = stop;
        else if (km > dahuKm && !next) next = stop;
      } else {
        if (km >= dahuKm) prev = stop;
        else if (km < dahuKm && !next) next = stop;
      }
    }

    const estimated = estimatePassTime(stops, dahuId);

    res.json({
      trainNo: tt?.TrainInfo?.TrainNo,
      type: tt?.TrainInfo?.TrainTypeName?.Zh_tw,
      direction: goingDown ? '下行' : '上行',
      totalStops: stops.length,
      dahuKm,
      dahuInStopTimes: !!stops.find(s => String(s.StationID) === dahuId),
      prevStop: prev ? { id: prev.StationID, name: prev.StationName?.Zh_tw, time: prev.DepartureTime||prev.ArrivalTime, km: STATION_KM[String(prev.StationID)] } : null,
      nextStop: next ? { id: next.StationID, name: next.StationName?.Zh_tw, time: next.ArrivalTime||next.DepartureTime, km: STATION_KM[String(next.StationID)] } : null,
      estimatedPassTime: estimated,
      officialWebsite: '(06:31)',
      accurate: estimated === '06:31' ? '✅ 完全吻合' : `差異：推算=${estimated} 官方=06:31`
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
    let data;
    try {
      data = await getStationTimetable(id, date);
    } catch(e) {
      if (e.message.includes('404') && id.length < 5) {
        const paddedId = id.padStart(5, '0');
        console.log(`Station ${id} 404, retry with ${paddedId}`);
        data = await getStationTimetable(paddedId, date);
      } else {
        throw e;
      }
    }
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/live', async (req, res) => {
  try {
    const map = await getLiveMap();
    res.json({ TrainLiveBoards: Object.entries(map).map(([TrainNo, DelayTime]) => ({ TrainNo, DelayTime })) });
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
