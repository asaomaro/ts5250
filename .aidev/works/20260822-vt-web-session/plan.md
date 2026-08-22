# 計画

| # | 内容 |
|---|---|
| 1 | WS のメッセージ型（`vt-opened` / `vt-screen` / `vt-input` / `vt-resize`）と wire 変換 |
| 2 | `VtManager` ＋ `ws-handler` の振り分け ＋ 差分と coalesce |
| 3 | 設定スキーマに `terminal: "vt"` と `encoding` |
| 4 | `VtPane.vue`（描画・スクロールバック・カーソル） |
| 5 | 打鍵・貼り付け・IME・マウス |
| 6 | 大きさの測定と NAWS |
| 7 | `ConfigCard` / `SessionInfo` / タブの表記 |
| 8 | テスト（server / web-ui）＋ 実ブラウザ検証 |

下から積む。各段でテストを緑にしてから次へ。
