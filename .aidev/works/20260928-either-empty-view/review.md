# レビュー: 全角の状態の E・J の欄のカーソルの桁と End

## タスク点検ログ
- (cross・委譲) [should] `packages/web-ui/src/components/ScreenGrid.vue` の `overwriteInto`・`insertInto`: 複数行の貼り付けで欄の途中まで埋める空白が半角のまま——貼る位置は全角空白で詰めた列ビューで数えるので、full/open の全角の E で字が左へずれ（17,15 に貼った い が 13 桁へ）、SO と SI の間に半角が混ざる / 対応: `pasteFill` で空きの種類に合わせて埋める（`either-empty-view.test.ts` の「複数行の貼り付け」。変異で検出。`insertInto` の側は同じ関数を通すだけで単体は無い）
- (cross・委譲) 確認して問題なし: 詰め物の全角空白で半角の E が全角へ化けない（切り替えは必ず欄を空にしてから詰める）・形が詰めと落としの間で変わらない・バイト予算・1 行の貼り付けと IME・基準値との比較で余計な MDT が立たない・先頭での半角への切り替え

## ラウンド 1
- 指摘なし（must 0 / should 0 / nit 0）。要件適合: AC1 は `either-empty-view.test.ts`（10 件）、AC2 は `verify-browser-either-empty-view.mjs` pass=7（直す前は pass=2 fail=5）。
  価値適合: 送るカーソル位置そのものを ACS の測定値と比べている。規約適合: 原典の読み（`getEndPosition`）と実機の 6 通りの両方で確かめた（原則 1・2）
