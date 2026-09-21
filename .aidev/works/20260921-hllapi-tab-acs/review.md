# レビュー: HLLAPI の Tab・Backtab

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目 9 の独立点検。`scratchpad/review-milestone9.md`）
- [should][conv:-] packages/tn5250/src/screen/search.ts:141 カーソル送りの番号を `index`（継続欄の全区間を数える）で引いていた。ACS は `getStandardFieldList`（継続欄の 2 区間目以降を除く）の番号で引くので、前に継続欄があると Tab・Backtab の行き先が違った（ペイン `EmulatorPane.vue` も同じ） / 対応: `progressionTarget` / `progressionNumberOf` を tn5250 に置き、HLLAPI とペインの両方がそれで引く。`Field.cursorProgression` の注記の主張も取り消し線で直した
- [nit][conv:-] packages/tn5250/test/tab-backtab-position.test.ts 「カーソルの手前が SO なら 1 つ戻す」が固定されていなかった / 対応: J 欄の最初の字からの Backtab のテストを足した（mutation で落ちる）
- 設計の記録の訂正: design の「欄の番号はスナップショットの `index`」は原典の手順と違った（取り消しはこのラウンドの対応で置き換えた）

## ラウンド 3（通過）
- ラウンド 2 の 2 件を直し、tn5250 とペインの両方でテストした。mutation で落ちることを確かめた。指摘なし。
