# 調査: READ の欄データの残り

## 判明した事実
- F1: ACS `DS5250.sendAll` の 0x52・0x82・0x83 の枝は、欄の種類を問わず `FFT5250.getFieldContents` の中身から**末尾の NUL だけ**を落とす（0x52 は途中の NUL を 0x40、ALT はそのまま）。平坦な形（case 6・66・114）の符号の畳みは 0x82 の枝と同じ文（手前の桁を見ない）
- F2: 実機の ACS のコア（DSM の READDBCS。2 回）: O `SO あ SI`＋実空白 8 → 12 バイト、＋NUL 8 → 4 バイト、`SO あ SI NUL A` → 0x52 `…0f40c1`・ALT `…0f00c1`、G `あ`＋0x40 6 → 8 バイト、＋NUL 6 → 2 バイト、J・E は構造のまま。G の `4482` は `4562` で届く（ACS・当 PJ とも）
- F3: 当 PJ（直す前）: O の実空白を落とす、ALT の途中の NUL を 0x40、G の NUL を 0x40 で詰める（`scripts/verify-read-dbcs-fields.mjs` pass=0）
- F4: 0x42 を DSM から出させる試み（`QsnPutInpCmd(0x42)` を READALT の画面の後）は、ACS が施錠のままで応答がカーソル 1,1・全欄空白になり測れなかった
- F5: PC コマンドの応答は `buildReadMdtResponse` 固定で、`readCommand` はそのレコードの READ を憶える前に呼ばれていた（`session.ts` の `runPcCommand`）

## 実装アンカー
- A1: `packages/tn5250/src/screen/buffer.ts` `dbcsRawFieldValue`
- A2: `packages/tn5250/src/protocol/read-response.ts` `sendValue`・`buildFieldResponse`・`flatValue`
- A3: `packages/tn5250/src/session/session.ts` `runPcCommand`・`buildAidRecord`
