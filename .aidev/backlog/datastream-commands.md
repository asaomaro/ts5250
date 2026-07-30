# 5250 データストリームの未実装コマンド

`wtd-applier.ts` の `default` 節は**未知のコマンドでレコードの残りごと捨てる**。
パラメータ長が分からない以上それは妥当だが、**捨てた後ろに READ があると入力待ちに入り、
利用者には「待機中・ホストから応答がない」としか見えない**。

この形で 3 回踏んでいる:

- `SAVE SCREEN`（0x02）に応答せず、SEU の F1 ヘルプが 30 秒返らなかった
- `WRITE ERROR CODE TO WINDOW`（0x22）未処理で、同じレコードの READ ごと捨てた
- **`SAVE PARTIAL SCREEN`（0x03）未処理で QSH が固まった**（2026-07-30・
  `20260730-qsh-save-partial-screen`。実測は `scripts/diag-qsh.mjs`）

## 実機で数えた（2026-07-30・`20260730-datastream-command-census`）

`scripts/census-5250-commands.mjs` で実機の**読み取り専用の画面 11 件**を巡り、
届いたコマンドを数えた（`STRSQL` / `DSPMSG` / `WRKACTJOB` / `WRKSYSSTS` / `DSPJOBLOG` /
`WRKSPLF` / `DSPLIBL` / `WRKOBJ` / `STRPDM` / `GO CMDIFS` / `QSH`。各画面で PageDown/PageUp も送信）。
**83 レコード中、未知のコマンドは 0 件。**

| コマンド（レコード先頭） | 回数 |
|---|---|
| `CLEAR_UNIT`(0x40) | 50 |
| `WRITE_TO_DISPLAY`(0x11) | 17 |
| `SAVE_PARTIAL_SCREEN`(0x03) | 2 |
| `WRITE_STRUCTURED_FIELD`(0xf3) | 1 |
| `RESTORE_PARTIAL_SCREEN`(0x13) | 1 |

## 確認済み

- [x] **RESTORE PARTIAL SCREEN（0x13）は届く**——**QSH を F3 で抜けるとき**
  - 中身は**こちらが `0x03` の応答で送った保管物そのもの**:
    `04 13 | 00 00 00 00 00 | 04 11 …（WTD）| … 04 52 …（READ）`
  - **不備が 1 件見つかって直した**: パラメータ 5 バイトを読み飛ばしておらず、
    続きを ESC と読み違えて `expected ESC, got 0x0 — discarding rest of record` で
    **ホストが返した画像と後続の READ を捨てていた**
    （F3 直後に別レコードで描き直されるため症状としては見えていなかった）

## 未実測のまま（この範囲では届かなかった）

**11 画面では 1 件も届かなかった**ので、実装は増やさない（形式を推測で書かない方針のまま）。
数え直す前に上記の census を再実行すること。

- [ ] **ROLL（0x23）**
  - 実装は入っている（`方向＋行数(1) 上端(1) 下端(1)`。SC30-3533 / tn5250 の定義）が**未実測**
  - 流れる画面（`DSPJOBLOG` / `WRKACTJOB` / `STRSQL` / `QSH`）でも、
    ホストは `CLEAR UNIT` ＋ `WTD` で**描き直していた**
  - どの画面が使うのかは依然として不明。System/36 環境や古いアプリが候補と見られる（未確認）
- [ ] `READ IMMEDIATE`（0x72）/ `READ IMMEDIATE ALT`（0x83）——届かなかった
- [ ] `READ SCREEN TO PRINT` 系（0x66 / 0x68 / 0x6A / 0x6C）——届かなかった
- [ ] **SAVE PARTIAL SCREEN のパラメータ 5 バイトの意味**
  - 実機はすべて `00`。**その写しが `0x13` で返ってくる**ことは分かったが、意味は**未解明**
  - 現状は解釈せず写して返す（ホストにとって不透明な保管物なので実害は無い）
  - ⚠ **読み飛ばす長さ 5 は「こちらが送った形」に依存**している。
    別の長さで `0x13` を送るホストがあれば崩れる（未確認）

## その他

- [ ] 装置名が使用中で接続を断られるとき、`expected ESC, got 0xc0 — discarding rest of record`
  が出る。5250 のレコードでないものを読んでいる（ホストが閉じる前に何か送っている）。
  **接続はどのみち失敗する**ので実害は無いが、由来は未解明

届いたことに気づけるよう、`unknown command 0x… — discarding rest of record` の警告は残してある。
