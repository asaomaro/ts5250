# 仕様: その場で戻る否定応答と CC2

## 概要
`applyDataStream` の否定応答の 4 か所を `abortRecord` に寄せ、警報・メッセージ待ちを落とす（decisions D1）。

## 設計方針
ACS は CC2 を尾部でまとめて効かせ、その場で戻ると飛ばす（research F1）。当 PJ は CC2 を WTD / READ の時点で結果に積むので、戻るときに打ち消す。

## 対象範囲
- `packages/tn5250/src/protocol/wtd-applier.ts`（`abortRecord` と 4 か所）
- テスト: `packages/tn5250/test/early-return-cc2.test.ts`（新規）
- 手順書: `scripts/README.md` の `dump` の説明（`mw=` ほか）
- 実機: `scripts/host-src/dscmd.c` の EARLYROLL・`scripts/acs-probe/early-return-cc2.txt`・`scripts/verify-early-return-cc2.mjs`・`scripts/acs-probe/AcsProbe.java` の dump に `mw=`

## 依拠する既存の事実
- CC2 は `applyCc2` が `result.alarm` / `result.messageWaiting` に積む（`wtd-applier.ts`）。セッションは `result.alarm` で警報、`result.messageWaiting` が定義されていれば表示灯を替える（`packages/tn5250/src/session/session.ts`）
- 主ループの後は `return finish()` だけ（`wtd-applier.ts`）——ESC が無いときの `break` を `return` に替えても同じ

## インターフェース / データ構造
- 変更なし（`ApplyResult` のまま）

## 振る舞いの詳細
- ESC が無い・CLEAR UNIT ALTERNATE の引数・ROLL の指定・WSF が短い: `senseCode` を立て、`alarm=false`、`messageWaiting` を消す。画面への書き込みはそのまま
- WSF D9/72 のフラグ 0x80: 従来どおり（CC2 は効く）

## エラー処理 / 異常系
- 変更なし

## 受け入れ基準との対応
- AC1: research F2・F3（`verify-early-return-cc2.mjs` pass=4、ACS のコア mw=false）
- AC2: `early-return-cc2.test.ts`（4 か所＋D9/72＋否定応答なし＋画面は残る）
- AC3: DLTPGM（CPC2191・CHKOBJ で CPF9801）と IFS の削除
