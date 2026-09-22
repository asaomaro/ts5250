# タスク: プリンターの申告と応答を ACS と同じにする

## 実装方針
申告（telnet 層の口 → 組の関数 → printer-session）→ 受信 → 実機 → 文書 の順。

## テスト方針
- 単体: 申告のバイト列（4 通り）、受信（終わり 16/17 バイト・CLEAR・応答の持ち越し・opcode 1/2 以外）。
- 実機: 日本語機で DBCS の帳票を push で受けて帳票になること。PUB400 で SBCS・DBCS の既存の E2E（verify-printer*.mjs）。

## タスク
- [x] T1: telnet 層に `userVars` と `sendConfRec` を足す。
      対象: `packages/tn5250/src/telnet/telnet.ts` `TelnetOptions` `handleSubnegotiation`
      依存: なし
      AC: AC1
- [x] T2: 申告の組 `printerDeclaration` と printer-session の接続。
      対象: `packages/tn5250/src/session/terminal-type.ts` `printerTerminalTypeFor`、`printer-session.ts` `connect`
      依存: T1
      AC: AC1
- [x] T3: 受信（終わりの判定・CLEAR・応答）。
      対象: `printer-session.ts` `handleRecord`
      依存: なし
      AC: AC3
- [x] T4: テストと mutation。
      対象: `packages/tn5250/test/telnet-printer.test.ts`、`printer-session.test.ts`
      依存: T2, T3
      AC: AC4
- [x] T5: 実機で確かめる（日本語機・PUB400）。
      対象: `scripts/verify-printer-declare.mjs`（新規）ほか既存の `verify-printer*.mjs`
      依存: T4
      AC: AC2
- [x] T6: 文書の訂正。
      対象: `README.md`、`docs/HOST-PRINT-TRANSFORM.md`
      依存: T5
      AC: AC2
