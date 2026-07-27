# 要件: DSPF の罫線（GRDATR/GRDLIN・WDWBORDER）を描く

## 背景 / 課題

実機環境からの調査報告（`dspf-report`）の残り 2 系統。PR #177 で (1) `DSPATR(CS)` は対応済み。

| 系統 | 5250 上の実体 | 状態 |
|---|---|---|
| (1) `DSPATR(CS)` | フィールド属性 | PR #177 で対応済み |
| **(2) `GRDATR` / `GRDLIN`** | WDSF `0x60` / `0x61` | **本作業** |
| **(3) `WDWBORDER`** | CREATE WINDOW の minor `0x01` | **本作業** |

### 現状（確認済み）

- `WDSF_TYPE` に `0x60` / `0x61` が無く、受信すると `kind: "unknown"` に落ちて**中身ごと捨てられる**
- `parseWindow()` は minor `0x10`（タイトル）しか見ておらず、
  minor `0x01`（Border Presentation）を**読み捨てている**。
  描画側はクライアント設定（`windowFrame` / `windowBackdrop`）だけで枠を描いており、
  **ホストが `WDWBORDER` で指定した罫線文字・色が参照される経路が存在しない**

## 原典で確認した構造（Wireshark 5250 ディセクタを直読）

`epan/dissectors/packet-tn5250.c` を取得し `dissect_draw_erase_gridlines()` /
`dissect_create_window()` を直読した。**報告書の記述と 1 点だけ食い違いがあり、原典を採る**。

### Draw/Erase Grid Lines（0x60）主構造 7 バイト

`partition(1) / flag1(1) / reserved(1) / flag2(1) / reserved(1) / default_color(1) / default_line(1)`

- `flag1` bit0: グリッドバッファのクリア指示
- 線種: `0x00` 実線 / `0x01` 太実線 / `0x02` 二重線 / `0x03` 点線 /
  `0x08` 破線 / `0x09` 太破線 / `0x0A` 二重破線 / `0xFF` 端末既定

### マイナー構造 10 バイト（type が 0x00–0x07 の間だけ続く）

`length(1) / minor_type(1) / ms_flag1(1) / start_row(1) / start_column(1) /
horizontal_dimension(1) / vertical_dimension(1) / default_color(1) / line_repeat(1) / line_interval(1)`

- `ms_flag1` bit0: **On = 消去 / Off = 描画**（原典 `tn5250_field_wdsf_deg_ms_flag1_0`）
- minor_type: `0x00` 上辺 / `0x01` 下辺 / `0x02` 左辺 / `0x03` 右辺 /
  `0x04` 罫線なしの箱 / `0x05` 横罫線付きの箱 / `0x06` 縦罫線付きの箱 /
  `0x07` 縦横罫線付きの箱（表形式。GRDLIN の典型用途）

### Border Presentation（CREATE WINDOW の minor 0x01）は **13 バイト**

`length(1) / minor_type(1) / flag1(1) / mba(1) / cba(1) /
ulbc(1) / tbc(1) / urbc(1) / lbc(1) / rbc(1) / llbc(1) / bbc(1) / lrbc(1)`

罫線文字 8 個は **EBCDIC 1 バイト**（原典が `ENC_EBCDIC` で読んでいる）。
**報告書は「10 バイト」としていたが原典は 13 バイト**——原典を採る
（AGENTS.md「仕様・定数は確認した事実として扱う」）。

## スコープ

### 対象
- `packages/core/src/protocol/wdsf-parser.ts` — 0x60 / 0x61 のパース、Border Presentation の読み取り
- `packages/core/src/protocol/wtd-applier.ts` / `screen/buffer.ts` — グリッド線の状態保持
- `packages/web-ui/src/components/ScreenGrid.vue` — グリッド線の描画・ホスト指定枠の反映
- 単体テスト＋**実機（）で DSPF をコンパイルして表示確認**

### 対象外
- グリッド線の印刷（`READ SCREEN TO PRINT WITH GRIDLINES`）
- 罫線の線種を CSS で完全再現すること（実線/破線/点線/二重線までとし、太字は色の濃さで代替しない）
- クライアント側の枠設定（`windowFrame` / `windowBackdrop`）の廃止——**ホスト指定を優先**しつつ既存設定は残す

## 完了条件

- [ ] `0x60` を受けてグリッド線の指定（位置・寸法・線種・色・描画/消去）を解釈できる
- [ ] `0x61`（Clear Grid Line Buffer）でグリッド線が消える
- [ ] `flag1` bit0（バッファクリア指示）で既存のグリッド線が消える
- [ ] minor_type 0x00–0x07 の 8 種すべてを解釈する
- [ ] `ms_flag1` bit0 で描画/消去を切り替える
- [ ] グリッド線が Web UI に**表示される**
- [ ] `WDWBORDER` の罫線文字 8 個と色をパースし、**ホスト指定の枠が描かれる**
- [ ] ホストが Border Presentation を送らない窓は**従来どおりクライアント設定の枠**
- [ ] 修正前に落ちる回帰テストがある
- [ ] build / test / lint / vue-tsc ビルドが通る
- [ ] **実機の実機で GRDLIN / WDWBORDER を使った DSPF を表示して確認**
