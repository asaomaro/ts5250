# 決定記録

## D1: エラー 32 は入れない

- 背景: ACS は右寄せ・符号付き数値の欄に打って欄を出ずに AID を押すとエラー 32 で止める（`fieldExitReqFlag`・`fieldExited`）
- 決定: HLLAPI では見ない。台帳に残す
- 理由 / 代替案: HLLAPI の表に Field Exit のニーモニックが無く、HLLAPI で書いた数値の欄を送る手段が無くなる。入れるなら「欄を出た」の追跡とニーモニックの追加が先

## D2: 施錠中は検査しない

- 背景: 独立レビューの指摘。ペインは施錠を先に見て送らない
- 決定: `snapshot.keyboardLocked` なら検査を飛ばして従来の経路へ
- 理由: 施錠中の扱い（core の `sendAid`）を変えない。検査でカーソルだけ動くのを避ける

## D3: 3270 の Tab の work（`20260928-hllapi-tab-3270`）は廃止し、台帳の訂正はこの PR に載せる

- 背景: HLLAPI は 5250 の `SessionManager` にしか繋がらない（`packages/server/src/app.ts` の `registerHllapiRoutes`）。台帳の前提が事実と違った
- 決定: コードは戻し、ACS の 3270 のコアを当てる足場（`PROBE_SESSION_TYPE`・`scripts/acs-probe/hllapi-tab-3270.txt`）と台帳の訂正をこの PR に含める
