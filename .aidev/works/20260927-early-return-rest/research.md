# 調査: その場で戻る否定応答の残り

## 判明した事実
- F1（原典 `DS5250.processCommand`）: READ（0x42/0x52/0x82）は CC1・CC2 を `lastReadCCbyte1/2` に控えるだけ。CC1 は使われず、CC2 は先に AID が溜まっていたとき（`checkPendingAid`）だけ効く。
  **実測は CC2 だけ（F5）。CC1 は未実測**——当 PJ の旧実装の CC1 は MDT の戻し等で、同じレコードの READ で ready に戻るので施錠の作用は無かった（review の確認）。
- F2（原典）: CLEAR UNIT ALTERNATE は `n5 > n2` のときだけ否定応答なしに戻る——ちょうど引数が無い形はレコードの外を読んで進む。
- F3（原典）: SAVE PARTIAL（case 3）は `bSavePartial` を立て、応答は尾部で送る。`bSavePartial` は先頭で捨てないので、その場で戻ったレコードの応答は次のレコードの尾部で送られる。
- F4（原典）: SAVE PARTIAL は溜めた CC2 をその場で効かせる（`processWCC2`。最後に `isPrepwcc2` を下ろす）。尾部の `processWCC2` は `isPrepwcc2` が立っているときだけなので、
  **SAVE PARTIAL の後ろに WTD がもう 1 本続いて `isPrepwcc2` が立ち直したときだけ**、OR で残った `pendingCCbyte2` により前の警報がもう一度鳴る（review で直した。~~警報は 2 回~~）。
  退避データの置き場は 1 つ（`saveddata`）で、新しい SAVE PARTIAL が上書きし、尾部で 1 本だけ送る。
- F5（実測。2026-09-27・社内機。DSM の READCC2 / CUANOPARM / SPROLL・ワイヤは `tap-proxy.mjs`〔記録は読み終えて消した〕）:
  - READCC2（READ MDT の CC2＝メッセージ待ちを点ける）: ACS のコア mw=false。
  - CUANOPARM（WTD〔CC2＝メッセージ待ち〕＋引数の無い CUA）: ACS のコアは画面を消し（5 行目が空）、mw=true、否定応答なし。
  - SPROLL（WTD＋SAVE PARTIAL＋不正な ROLL、後で WTD＋READ）: ACS のワイヤは 0x1005012C の否定応答が先、SAVE PARTIAL の応答はその後。
  - 当 PJ（直す前）: READ の CC2 を効かせ、引数の無い CUA は読み過ぎの例外、SAVE PARTIAL の応答を否定応答より先に送っていた。
- F6（実測・直した後）: `scripts/verify-early-return-rest.mjs` pass=4。

## 実装アンカー
- A1: `applyDataStream` の READ・CLEAR UNIT ALTERNATE・`abortRecord`（`wtd-applier.ts`）
- A2: `Session5250.handleRecord` の退避の応答・`sendNegative`（`session.ts`）
