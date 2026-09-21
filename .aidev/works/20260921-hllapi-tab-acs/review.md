# レビュー: HLLAPI の Tab・Backtab

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目 9 の独立点検。`scratchpad/review-milestone9.md`）
- [should][conv:-] packages/tn5250/src/screen/search.ts:141 カーソル送りの番号を `index`（継続欄の全区間を数える）で引いていた。ACS は `getStandardFieldList`（継続欄の 2 区間目以降を除く）の番号で引くので、前に継続欄があると Tab・Backtab の行き先が違った（ペイン `EmulatorPane.vue` も同じ） / 対応: `progressionTarget` / `progressionNumberOf` を tn5250 に置き、HLLAPI とペインの両方がそれで引く。`Field.cursorProgression` の注記の主張も取り消し線で直した
- [nit][conv:-] packages/tn5250/test/tab-backtab-position.test.ts 「カーソルの手前が SO なら 1 つ戻す」が固定されていなかった / 対応: J 欄の最初の字からの Backtab のテストを足した（mutation で落ちる）
- 設計の記録の訂正: design の「欄の番号はスナップショットの `index`」は原典の手順と違った（取り消しはこのラウンドの対応で置き換えた）

## ラウンド 3（通過）
- ラウンド 2 の 2 件を直し、tn5250 とペインの両方でテストした。mutation で落ちることを確かめた。指摘なし。

## ラウンド 4（節目 10 の独立点検。`scratchpad/review-milestone10.md`）
- [nit] Backtab の ACS の癖（継続欄の 2 区間目以降の先頭では `indexOf` が -1 になり、番号 0 の欄を探す）を写していない。ペインの Backtab も同じ / 対応: 台帳へ。「ペインは既に ACS と同じ」を取り消し線で直した
- [nit] packages/tn5250/src/screen/search.ts:145 `standardFields` の doc が「欄の定義順」だが、実際は画面順（ACS は定義順。昇順に定義される限り同じ）/ 対応: doc を直し、昇順でない定義の画面は未確認と台帳へ
- [nit] `progressionTarget` の境界: ACS は `n <= size()`（全区間の数）で検査して標準の並びを引くので、区間の多い画面では範囲外になりうる / 対応: 台帳へ

## ラウンド 5（通過）
- 節目 10 の指摘（nit 3）を doc と台帳で直した。点検役の変異のうちこの work の分（P1〜P8）が、直した後のテストで落ちる（8/8）。指摘なし。
