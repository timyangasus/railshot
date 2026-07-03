# Railshot Server

Railshot 的後端 Proxy，負責向 TDX 取得真實台鐵資料。

## API 端點

| 端點 | 說明 |
|------|------|
| `GET /api/health` | 確認 server 是否正常 |
| `GET /api/od/:from/:to/:date` | OD 時刻查詢（時刻表 Tab 用） |
| `GET /api/station/:stationId/:date` | 依車站查詢當日班次（拍車 Tab 用） |
| `GET /api/live` | 即時誤點資訊 |
| `GET /api/stations` | 全台鐵車站清單 |

## 部署到 Render.com

1. 把這個資料夾推到 GitHub（獨立 repo 或子資料夾）
2. 到 [render.com](https://render.com) → New → Web Service
3. 選擇 repo
4. 設定：
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. 新增環境變數（到 [TDX 開發者平台](https://tdx.transportdata.tw/user/dataservice/register) 註冊會員取得）：
   - `TDX_CLIENT_ID` = 你的 TDX Client ID
   - `TDX_CLIENT_SECRET` = 你的 TDX Client Secret
6. 部署完成後，複製 Render 給你的網址（例如 `https://railshot-server.onrender.com`）

## 連接前端

打開 `railshot/index.html`，找到這一行：

```js
const API_BASE = '';  // 空字串 = 使用假資料模式
```

改成：

```js
const API_BASE = 'https://railshot-server.onrender.com';
```

存檔後推到 GitHub，前端就會使用真實 TDX 資料。

## 注意

- Render 免費方案閒置 15 分鐘後休眠，第一次請求需等約 30 秒喚醒
- TDX 免費方案每日 50,000 次請求，個人使用完全足夠
