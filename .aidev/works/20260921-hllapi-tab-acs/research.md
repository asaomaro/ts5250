# 調査: ACS の Tab・Backtab の行き先

## 判明した事実
- F1（原典）: `PS5250.processTab` は `FFT5250.nextNonByPassInputFieldPos(カーソル)`（-1 なら画面のホーム位置）、`processBacktab` は手前が SO なら 1 つ戻して
  `previousNonByPassInputFieldPos(カーソル−1)`（-1 なら動かない）。
- F2（原典）: `nextNonByPassInputFieldPos` はカーソルの下の欄のカーソル送り（バイパスでない送り先）を優先し、次にカーソルより後で始まる最初のバイパスでない欄
  （継続欄は 1 区間目だけ）、無ければ最初のバイパスでない欄。`previousNonByPassInputFieldPos` はカーソル送りが使われている画面で「引数＋1 が欄の先頭」なら
  そこへカーソル送りで来る欄、そうでなければ引数以前で始まる最後の欄（同じ条件）、無ければ最後の欄。どちらも着いた桁が SO なら 1 進める（O の欄を除く）。
- F3（実機・ACS のコア。`scripts/acs-probe/backtab-home.txt`）: 7,22 → 7,20・7,20 → 5,20・7,26 → 7,20（`20260921-backtab-acs`）。
- F4（当 PJ）: `packages/server/src/hllapi.ts` の `moveCursor` の tab / backtab は `nextInputField` / `prevInputField`（次 / 前の入力欄の先頭）。
