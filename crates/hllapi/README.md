# ts5250-hllapi

ts5250 の **HLLAPI / EHLLAPI 接続層**。

**このクレートは薄い。** C ABI で受けた 4 つのポインタを JSON にして
ts5250 サーバーへ HTTP で投げ、返ってきたものを書き戻すだけ。
**機能番号の意味も、画面の解釈も、戻り値の決め方もここには無い**——
すべて TypeScript 側（`packages/server/src/hllapi.ts`）にある。

詳細は [`docs/HLLAPI.md`](../../docs/HLLAPI.md)。
