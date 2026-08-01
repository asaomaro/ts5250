# 仕様: LOB ロケーターの解放

## 概要

`freeLob(conn, locator)` を実装し、`index.ts` から公開する。
**`fillLobs` には組み込まない**（`decisions.md` D1）。

## 設計方針

- **要求は原典と同じ形**: `reqId=0x1819` / パラメータは `lobLocatorHandle`（`0x3818`）1 つ /
  ORS は `sendReplyImmediately` のみ（結果データを要求しない）
- **投げない**。`Promise<boolean>` を返す。後始末で例外を出すと「値は取れたのに落ちる」
- **「もう無い」は騒がない**: `ALREADY_FREED = {-401, -816}` は `debug`。それ以外の失敗は `warn`
- **自動解放しない**（D1）

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/hostserver/src/db/db-datastream.ts` | `DB_REQ.freeLob = 0x1819` |
| `packages/hostserver/src/db/lob.ts` | `freeLob` と `ALREADY_FREED` |
| `packages/hostserver/src/index.ts` | `freeLob` を公開 |
| `packages/hostserver/test/lob-free.test.ts` | 新規（要求の形・戻りの扱い） |
| `scripts/research-lob-free.mjs` | 新規（実機の再現） |

## 受け入れ基準との対応

requirement の完了条件に一対一（結果は `test-result.md`）。
