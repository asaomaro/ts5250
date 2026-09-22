# レビュー: Home・Record Backspace

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・5 件をまとめて。差し戻し）
- 別コンテキストに 5 コミット（e100b573・6c702521・51abff32・2708da79・194c6e18）の相互作用を読ませた。自作の再現テストで裏を取った指摘だけ。
- [must][conv:-] `EmulatorPane.vue` `homeKey` — 3270 のセッション（同じペインで描く）でも Home で Record Backspace を送り、サーバーが「知らない AID」として断ってエラーの通知が出る / 対応: 5250 のときだけ（`is5250`）。3270 は従来どおり先頭の入力欄へ。テスト 1 件
- [must][conv:-] ホーム位置が窓の IC を指したまま（退避・復元の IC）/ 対応: `20260921-cursor-per-wtd-acs` のラウンド 2 で直した
- [nit][conv:-] 読み取り専用のセッションでもホーム位置の Home で Record Backspace を送り、サーバーが断る / 対応: **変えない**（D4）。読み取り専用では Enter などの AID も同じくサーバーが断って通知を出す作りで、Home だけ特別にしない
- [nit][conv:paired-artifact-sync!] `hllapi-keys.ts`・`hllapi.ts` — 「mcp-tools の AID と一致させる」とある HLLAPI の AID の表に `RecordBackspace` が無く、`@0`（Home）も先頭の入力欄へのまま / 対応: 表に足し、`@0` はホーム位置へ・そこなら Record Backspace（ホーム位置を持たない 3270 は従来どおり）。テスト 2 件

## ラウンド 3（通過）
- 修正を外す mutation（V-3・V-8・V-9）で検出。
