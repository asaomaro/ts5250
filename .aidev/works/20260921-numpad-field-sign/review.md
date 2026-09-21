# レビュー: テンキーの ± と Field−

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・5 件をまとめて。差し戻し）
- 別コンテキストに 5 コミット（e100b573・6c702521・51abff32・2708da79・194c6e18）の相互作用を読ませた。自作の再現テストで裏を取った指摘だけ。
- [must][conv:-] `useKeymap.ts` `classifyKey`・`ScreenGrid.vue` — テンキーの ± を 3270 のセッションにも Field± として当てた（3270 の英数字欄でテンキーの − が 0022 になり `-` が打てない）/ 対応: 5250 のときだけ（`numpadFieldSign(ev, fieldSignKeys)`・ScreenGrid の `fieldSignKeys` prop）。テスト 2 件
- [must][conv:-] `useKeymap.ts` `classifyKey` — IME の変換中（key が `Process`）も `code` だけで Field± に振り分け、変換の途中で欄を出た / 対応: `key` も `-` / `+` であること・`isComposing` でないことを見る。テスト 3 件
- [should][conv:-] `EmulatorPane.vue` の矩形選択 — キャレットから始めた選択の最中のテンキーの − が、`code` を持たない合成 keydown で文字 `-` として入った / 対応: 選択を解いて、`code` 付き・伝わる形で欄の input から送り直す（欄が caret を取り直してからペインが Field− を実行）。テスト 1 件
- [nit][conv:-] `useKeymap.ts` の LOCAL_EDIT_ACTIONS — 「打鍵の `-` / `+` も数値欄ではここへ横流しする」が撤去後も残っていた / 対応: 取り消し線で直した

## ラウンド 3（通過）
- 修正を外す mutation（V-4・V-5・V-5b・V-6・V-10）で検出。
