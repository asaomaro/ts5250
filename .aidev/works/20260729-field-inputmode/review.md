# レビュー記録

## ラウンド 1（2026-07-29T23:10Z）

差分: core（`types.ts` に `digitsOnly?`、`buffer.ts` の snapshot で設定）＋
web-ui（`ScreenGrid.vue` の `inputModeOf`）＋テスト 2 本。

### 指摘

- [should] テストの FFW に識別ビット `0x4000` が抜けており `invalid FFW 0x300` で落ちた。
  実装の問題ではなくテストの組み立て誤り。/ 対応: 修正

### 規約適合

- **塞がない**（AGENTS.md）: 絞るのは「ホストが数字だけと申告した欄」に限定。
  他は今日と同じフルキーボード。
- コメントは why 中心。「なぜ `numeric` 全体に付けないか」を許容集合つきで残した。
- `digitsOnly` は `signedNumeric` / `dbcsType` と同じく**当てはまるときだけ付ける**形にそろえた。

### 再検証

- core 80 files / 919 tests 全通過
- web-ui 95 files / 1099 tests 全通過
- `npm run build`・`vue-tsc` 込みビルド通過

### 判定

**通過。**
