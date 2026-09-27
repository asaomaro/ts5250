# 仕様: READ の欄データの加工

## 概要
欄データを「桁ごとの字 ＋ NUL の印」で組み、0x52 と ALT で加工を分ける（ACS `DS5250.sendAll` と同じ手順）。

## 設計方針
- `FieldDataForm = "mdt" | "alt"` を `buildFieldResponse` に渡す。`sendValue` は区間を連結した桁ごとの字（`fieldValue(seg, true)`）と NUL の印（`cellAt(addr) === null`）を作り、
  末尾の NUL だけ落とす。alt は途中の NUL を生バイト 0x00（センチネル）にして終わり。mdt は途中の NUL を空白にし、符号付き数値で末尾を落としていなければ符号を畳む。
- 1 桁 1 字にならない欄（未編集の DBCS 欄）は従来の `trimmedSendValue` に回す。
- `buildReadMdtAltResponse`（0x82）を足し、セッションは `readCommand` が 0x82 ならそれで返す。0x83 も alt。

## 対象範囲
- `read-response.ts`・`session.ts`、テスト

## 依拠する既存の事実
- NUL は `null` のセル（research F3。`wtd-applier.ts` の NUL の書き込み）、`cellAt` は公開（`buffer.ts` `cellAt`）
- 0x82 の `readCommand` は `wtd-applier.ts` の READ の枝で入る（`case COMMAND.READ_MDT_FIELDS_ALT`）

## 受け入れ基準との対応
- AC1: `read-alt-raw.test.ts` が F2 の ACS の値を期待値にする。`read-input-fields.test.ts` でセッションの 0x82 の選択
- AC2: `scripts/verify-read-alt.mjs` を修正後に実機で回す
- AC3: 測定の後に DLTPGM と IFS の削除
