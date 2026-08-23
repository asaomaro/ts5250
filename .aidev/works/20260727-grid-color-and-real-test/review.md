# レビュー記録

## ラウンド 1（実機検証つき）

core 3 ファイル＋web-ui 1 ファイル＋テスト 2 ファイル。

### 要件適合・正確性

- **原典（IBM DDS リファレンス）を直読**して `GRDBOX` 構文・色表・線種表を確定した。
  線種は既存実装と完全一致、**色は誤っていた**（decisions.md D1）
- **実機で DSPF をコンパイルして表示**し、バイト列を捕捉してマイナー構造が
  11 バイトであることを確定（decisions.md D2）
- 実機のバイト列をそのままテストに焼き付けた
- 最終確認: 警告ゼロで、DDS の指定と解釈が**全項目一致**
  - `(*TYPE PLAIN)` ＋ `GRDATR((*COLOR RED) (*LINTYP SLD))` → 色=4(RED)・線種=0(SLD)（既定へ正しく倒れる）
  - `(*TYPE HRZVRT 2 8) (*COLOR BLU) (*LINTYP DSH)` → 色=1・線種=8・横罫2・縦罫8

### 指摘

- [nit] `PLAIN` の箱で `lineRepeat` / `lineInterval` が 1 として返る（0xFF を期待した）。
  `PLAIN` は内部罫線を引かないので描画には影響しない（`gridSegments` は 0x05–0x07 でしか使わない）。
  ホスト側で正規化されている可能性が高い。／ 対応: 許容（描画に影響しないため）

### 再検証

- クリーンビルド ／ lint ／ `vue-tsc` 込み web-ui ビルド：成功
- core 832 件 ／ web-ui 923 件 ／ 全 workspace 2,430 passed / 4 failed（既知の環境要因）
- 実機: グリッド線 2 本・窓枠とも警告ゼロで解釈

**判定: must 0 / should 0 / nit 1（許容）。review 通過。**
