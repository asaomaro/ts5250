# 仕様: READ の欄データの残り

## 概要
未編集の DBCS 欄を桁ごとに取り出し（NUL を区別）、ACS `sendAll` の規則で組む。平坦な形の符号と PC コマンドの応答の形を ACS・AID と揃える。

## 依拠する既存の事実
- 未編集の DBCS 欄は `hasDbcsStructure` で見分け、`dbcsRawFieldValue` が原本のバイトをセンチネルで返す（`buffer.ts`）
- 0x52 の符号の畳み方は実機で測ってある（`20260927-read-alt-raw`、`read-response.ts` の `sendValue`）

## インターフェース / データ構造
- `ScreenBuffer.dbcsRawCells(field): (string | undefined)[] | undefined` — 1 桁 1 要素・空のセルは `undefined`・構造が無ければ `undefined`
- `read-response.ts` の `rawDbcsSendValue(buf, f, form)` — 継続欄を連結し末尾の NUL を落とす
- `Session5250.readResponseBuilder()` — 待たされている READ から応答の組み方を選ぶ

## 受け入れ基準との対応
- AC1: `rawDbcsSendValue` を `sendValue` と G の枝で使う（G は詰めない。奇数長は偶数へ丸める）
- AC2: `flatValue` で手前の桁のバイトを見ずにゾーンを 0xD
- AC3: `runPcCommand` が `readResponseBuilder` を使い、PC コマンドのレコードでも `readCommand` を先に憶える
- AC4: DLTPGM・IFS の削除
