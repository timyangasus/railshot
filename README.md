# Railshot 🚂

**鐵道攝影助手** — 給鐵道迷、鐵道攝影者使用的 PWA App

## 功能

- 📷 **拍車** — 選擇拍攝點，查詢未來會經過哪些列車、倒數分鐘、誤點狀態
- 🕐 **時刻表** — 快速查詢站間班次
- ⭐ **收藏** — 儲存常用拍攝點與班次
- 🔔 **提醒** — 列車通過前 5 分鐘提醒

## 安裝到手機（PWA）

1. 用手機瀏覽器開啟網址
2. **iOS Safari**：點下方 `分享` → `加入主畫面`
3. **Android Chrome**：點右上角選單 → `安裝應用程式`

## 部署

此為單一 HTML 檔，直接部署即可：

- **GitHub Pages**：將 `index.html` 推到 `main` 分支，啟用 GitHub Pages
- **Netlify / Vercel**：拖曳資料夾上傳

## 技術說明

- 純 HTML / CSS / JavaScript，無需框架
- 目前使用假資料，可串接 [TDX 交通部 API](https://tdx.transportdata.tw) 取得真實台鐵時刻
- 收藏資料儲存於 `localStorage`

## 開發計畫

- [ ] 串接 TDX API（需後端 Proxy 解決 CORS）
- [ ] 即時誤點資料
- [ ] 列車追蹤功能
- [ ] 拍攝點地圖模式

## 資料來源

台鐵車站資料參考台鐵官方站序

---

Made with ❤️ for 鐵道攝影愛好者
