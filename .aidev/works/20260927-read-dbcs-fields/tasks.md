# タスク: READ の欄データの残り

## 実装方針
下の `依存:` に従う。

## テスト方針
- 単体（ACS の実測のバイト列）・変異・実機（`scripts/verify-read-dbcs-fields.mjs`・`verify-read-alt.mjs` の回帰）

## タスク
- [x] T1: 未編集の DBCS 欄の欄データ
      対象: `packages/tn5250/src/screen/buffer.ts` `dbcsRawFieldValue`・`packages/tn5250/src/protocol/read-response.ts` `sendValue` / 根拠: research A1, A2
      依存: なし
      AC: AC1
- [x] T2: 平坦な形の符号
      対象: `packages/tn5250/src/protocol/read-response.ts` `flatValue` / 根拠: research A2
      依存: なし
      AC: AC2
- [x] T3: PC コマンドの応答
      対象: `packages/tn5250/src/session/session.ts` `runPcCommand` / 根拠: research A3
      依存: なし
      AC: AC3
- [x] T4: DSM・プローブ・検証スクリプト・README・片付け
      対象: `scripts/host-src/dscmd.c`・`scripts/acs-probe/read-dbcs-fields.txt`・`scripts/verify-read-dbcs-fields.mjs`・`scripts/README.md`
      依存: T1
      AC: AC1, AC4
