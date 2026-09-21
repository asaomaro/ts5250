# タスク: DBCS の端末タイプ

## テスト方針
- 端末タイプを単体で固定。実機で G02 と C01 を同じ手順で比べる（STRSEU を含む）。ACS のワイヤと並べる。

## タスク
- [x] T1: ACS のワイヤと、実機での G02 / C01 の比較。
      対象: なし（scratchpad の手順。リポジトリには入れない）
      依存: なし
      AC: AC1, AC2
- [x] T2: `terminalTypeFor` と文書（`docs/PROTOCOL.md`・`scripts/verify-dbcs-tls.mjs`・`scripts/README.md`）。
      対象: `packages/tn5250/src/session/terminal-type.ts`
      依存: T1
      AC: AC1
- [x] T3: テスト。
      対象: `packages/tn5250/test/terminal-wide.test.ts`
      依存: T2
      AC: AC1
