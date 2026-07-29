# レビュー記録

## ラウンド 1（2026-07-29T20:55Z）

差分: `fkeyLegend.ts`（`sameScreen` / `introducedOutside` 追加、`detectWindowRect` に `prev`）＋
`ScreenGrid.vue`（判定を watch 化）＋ 実機 fixture 13 対 ＋ 新規テスト 1 本。

### 指摘

- [must] `ScreenGrid.vue` の watch に表示設定（`showShiftMarks` / `sbcsView`）を含めていたため、
  **設定変更時に `prev === snap` となり画面を自分自身と比較**していた。枠外は当然無変化なので
  裏取りが素通りし、**③ が窓に化ける**。/ 対応: 修正（`props.snapshot` だけを watch。decisions D1）

### 規約適合

- コメントは why 中心。特に非自明な 2 点（外周を含めて測る理由・`文字→空白` を数えない理由）は
  実測値つきで `introducedOutside` に残した（AGENTS.md）。
- 利用者に見えるメッセージの追加なし。core には触れていない。
- `detectWindowRect` の戻り値の形は変えていないので、装飾側（`winRectStyle` / `smokeRects`）は無変更。

### 再検証

- web-ui 92 files / 1064 tests 全通過（既存 6 本の窓テストを含む）
- core 79 files / 915 tests 全通過
- `npm run build`・`npm run build -w @as400web/web-ui`（vue-tsc 込み）通過
- lint: 変更ファイルはエラー 0

### 判定

**通過。** deliver へ進む。
