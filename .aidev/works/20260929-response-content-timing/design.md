# 仕様: READ SCREEN の応答を命令の時点の画面で組む

## 概要
`applyDataStream` の `opts.buildReadScreen`（セッションが渡す）を、READ SCREEN・READ SCREEN TO PRINT の命令に達した時点で呼び、得たレコードを `read-screen` の応答枠（`ResponseSlot.record`）に持たせる。
セッションの応答ループは `slot.record` があればそれを送る。

## 設計方針
- 組む処理（`buildReadScreenResponse`）はセッションが持つ（コーデックと受信 opcode が要る）。applier は呼ぶだけ
- SAVE の本体・EXTENDED・IMMEDIATE 系は変えない（測っていない・画面に出ない差は台帳）

## 依拠する既存の事実
- `read-screen` の応答枠は `wtd-applier.ts` の `COMMAND.READ_SCREEN`・`READ_SCREEN_TO_PRINT`・`READ_SCREEN_TO_PRINT_GRID` の 3 か所で積む（research A1）
- 応答ループは `session.ts` で、READ SCREEN 系はレコードにつき 1 本（最初の位置で送る）（research A2）

## インターフェース / データ構造
- `ResponseSlot`: `{ kind: "read-screen"; record?: Uint8Array } | { kind: "read-screen-ext" | "read-immediate" | "read-mdt-imm-alt" }`
- `applyDataStream(..., opts: { buildReadScreen?: () => Uint8Array })`

## 受け入れ基準との対応
- AC1: `packages/tn5250/test/read-screen-timing.test.ts`（`[READ SCREEN][WTD]` と対照 `[WTD][READ SCREEN]`）
- AC2: `scripts/verify-read-screen-timing.mjs`（DSM の READSCRTIMING・READSCRTIMING2 の応答を ACS のワイヤと比べる）
