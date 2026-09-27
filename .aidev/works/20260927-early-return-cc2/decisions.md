# 決定記録

## D1: その場で戻る否定応答（当 PJ の 4 か所）では、同じレコードの CC2 の警報・メッセージ待ちを落とす

- 背景: research F1（原典）と F2（実機: ACS のコアは点けず、当 PJ は点けた）。
- 決定: `abortRecord`（`wtd-applier.ts`）で否定応答を立て、`alarm` を false・`messageWaiting` を未設定に戻す。WSF D9/72 のフラグは通さない（尾部が走る）。
- 経緯: 測定を先に行い、その結果を受けて実装してから工程の文書を起こした（前の work〔プリンター〕の実機の待ち時間に並べて進めたため）。requirements の時点で振る舞いは実測で確定していた。

## D2: SAVE PARTIAL の持ち越し・READ の解錠・短いレコードの否定応答は範囲外（backlog）

- SAVE PARTIAL: ACS は戻ったレコードの応答を次のレコードの尾部に持ち越す（F1）。1 レコードに SAVE PARTIAL と不正なコマンドが並ぶ形は実機で出させていない。
- 当 PJ は WTD・READ・WRITE ERROR CODE の本体が無いレコードを否定応答にしていない（ACS はする。F1）。いずれも測ってから決める。

## D3: SAVE PARTIAL より前の CC2 は落とさない

- 背景: T1 の点検。ACS の SAVE PARTIAL（case 3）は `processWCC2` をその場で呼び、それまでに溜めた CC2 を効かせる（`isPrepwcc2` も落とす）。
- 決定: SAVE PARTIAL の時点の警報・メッセージ待ちを `committedCc2` に控え、`abortRecord` はそこまで戻す。
- 範囲外（backlog）: ACS の READ の CC2 は溜めない（`lastReadCCbyte2`。尾部で効くのは保留の AID があるときだけ）が、当 PJ は常に効かせる——既存の差。
