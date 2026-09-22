# 決定記録

## D1: Home の要判断は「ACS に合わせる」（利用者の判断）

- 背景: 台帳で「要判断」だった（欄の先頭へ移る当 PJ の動きに慣れた利用者がいる）。
- 決定: 利用者の方針「ACS に合わせて」に従い、画面のホーム位置へ移り、ホーム位置では Record Backspace を送る。

## D2: READ INPUT FIELDS 側の分岐は置かない

- 一度 `buildReadInputFieldsResponse` にも `NO_DATA_AIDS` の分岐を足したが、平坦な応答の門番（`sendsData`）が同じ集合を見るので等価だった（mutation H-g が生き残った）。分岐を外し、門番 1 か所に寄せた。

## D3: PA1〜3 は集合に載せない

- ACS は PA1〜3 も欄データを載せないが、当 PJ は PA キーを送れない（`AidKey` に無い）。載せても通らない値になるので、PA キーを足す項目（台帳の「未対応の機能」）で一緒に入れる。

## D4: 読み取り専用のセッションでもホーム位置の Home は Record Backspace として扱う（サーバーが断る）

- 背景: 独立点検の nit。以前の Home は手元の移動だけだったので、読み取り専用で通知が出ることは無かった。
- 決定: 変えない。読み取り専用では Enter・F キーなどの AID もペインは送り、サーバーが断って通知を出す作り（`session-manager.ts` の `assertKeyAllowed`）。Record Backspace も AID なので同じ扱いにそろえる。
- 代替案: ペインで読み取り専用なら送らない——AID のうち Home だけを特別扱いすることになるので退けた。

## D5: HLLAPI の @0 もホーム位置・Record Backspace にそろえる（対になる入口）

- 独立点検の nit（`paired-artifact-sync`）。HLLAPI は SendKey の Home を手元で処理しているので、ペインと同じ規則に合わせた。ホーム位置を持たない画面（3270）は従来どおり先頭の入力欄へ。Backtab（`@B`）は `prevInputField` が「開始が現在位置より前の最後の入力欄」で、欄の途中ならその欄の先頭になり ACS と同じ結果（継続欄と逆向きのカーソル送りは見ていない。台帳の残りに入れる）。
