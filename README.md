# 六子棋 Connect Six

網頁版六子棋對戰遊戲，內建高強度 AI 引擎與「上弦之貳・童磨」風格的嘲諷對話系統。

**線上遊玩：** https://tonnychiulab.github.io/666/

## 遊戲規則

1. 黑棋先手，第一手只下 1 子
2. 之後雙方每回合各下 2 子
3. 先連成 6 子者勝
4. 連成 7 子以上為和局

## 特色

- **AI 引擎（v2.0 重寫）**：視窗式威脅評估、雙子配對 negamax + alpha-beta 搜尋、迭代加深時間控制。9 段等級以擊敗人類棋手為目標設計
- **1-9 段棋力可選**：低段會放水，適合入門；9 段火力全開
- **Web Worker 運算**：AI 思考不卡 UI（需以 http/https 開啟；file:// 自動退回主執行緒模式）
- **童磨對話系統**：AI 模式下，開局、進攻、防守、勝敗都有對應台詞
- **四種對戰場景**：客棧、泡沫紅茶、廟口、公園
- 悔棋、提示、棋譜記錄與匯出、雙人對戰模式

## 檔案結構

```
index.html    頁面結構
style.css     樣式與場景主題
game.js       棋盤邏輯、渲染、遊戲流程、UI
ai-worker.js  AI 引擎（Web Worker / 主執行緒共用）
```

## 本機執行

直接開啟 `index.html` 即可，或起一個本機伺服器讓 AI 走 Web Worker：

```bash
npx serve .
```

## 開啟 GitHub Pages

1. 到 repo 的 **Settings → Pages**
2. **Source** 選 `Deploy from a branch`
3. **Branch** 選 `main`、資料夾選 `/ (root)`，按 **Save**
4. 約一分鐘後即可從 https://tonnychiulab.github.io/666/ 開啟

## 版本

v2.0.0 — AI 引擎完整重寫、童磨對話系統、致命 bug 修復
