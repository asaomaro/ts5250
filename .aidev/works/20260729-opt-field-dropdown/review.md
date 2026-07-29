# レビュー記録

## ラウンド 1（2026-07-29T21:25Z）

差分: `fkeyLegend.ts`（`legendsInRow` の一般化＋検出 2 つ）/ `viewSettings.ts`（`optHints`）/
`ScreenGrid.vue`（オーバーレイ）/ `EmulatorPane.vue`（配線）/ `opMessages.ts`（文言）＋
実機 fixture 5 画面＋テスト 2 本。

### 指摘

- [must] **負のテストが規則を突けていなかった**。`wrkmsgq` / `menu` は凡例が無いから null に
  なっていただけで、「凡例と Opt 列が両方揃ったときだけ発火する」という肝心の規則が
  1 つもテストされていなかった（空振り検証で判明）。/ 対応: 修正（decisions D3）

- [must] 選択の反映が非フォーカス経路（`emit("edit")`）へ落ちており、
  カーソル・編集状態が打鍵時と食い違っていた。/ 対応: 修正（decisions D2）

### 規約適合

- 利用者に見える文言は `opMessages.ts`（`MSG_OPT_HINTS`）に置き、**テストは定数を参照**（AGENTS.md）
- `VIEW_ITEMS` へ足したので**画面設定メニューとキー設定の両方に自動で出る**（2 か所に書かない）
- 既定 OFF（推測を含む機能を勝手に有効化しない）
- コメントは why 中心。特に「なぜ mousedown を止めるのか」「なぜキーを購読しないのか」は
  干渉の中身つきで残した

### 再検証

- web-ui 94 files / 1083 tests 全通過
- `npm run build -w @as400web/web-ui`（vue-tsc 込み）通過

### 判定

**通過。** deliver へ進む。

## ラウンド 2（2026-07-29T22:10Z・UI 再設計後）

利用者指摘（フォーカスだけで開くのは視覚的に邪魔／Tab 到達の許可／ペイン移動キーの変更）を反映。

### 指摘

- [must] フォーカスだけでリストが開く実装は、一覧を移動するたびに視界を塞ぐ。
  / 対応: 修正（ボタン＋`Alt+↓` の明示操作。decisions D4）

- [should] テストデータの Opt 欄がヘッダー行（`OPT …`）と重なっており、右隣 c4 が `T` で
  埋まっていた。**実装は正しくボタンを出さない判定をしていた**が、テストが意図を外していた。
  / 対応: 行をずらし、併せて「右隣が埋まっていればボタンを出さない」を明示的に固定するテストを追加

- [should] `global-shortcuts.test.ts` が旧バインド（`Alt+矢印`）を固定していた。
  / 対応: `Alt+Shift` へ更新し、「Shift 無しの `Alt+↓` は消費しない」ケースを追加

### 再検証

- web-ui 94 files / **1086 tests 全通過**
- `npm run build`（tsc -b）・`npm run build -w @as400web/web-ui`（vue-tsc 込み）通過

### 判定

**通過。**
