# タスク: 暗号化した自動サインオン

## テスト方針
- 代替パスワードは ACS の出力と突き合わせ、telnet は IS の形と順序、サーバーは配線とレベルの扱い。実機。mutation。

## タスク
- [x] T1: 原典と実測（ACS のコアの暗号化した自動サインオンをタップで採る。PUB400）。
      対象: `scripts/acs-probe/AcsProbe.java`（`PROBE_PASSWORD_LEVEL`）
      依存: なし
      AC: AC2, AC3
- [x] T2: 代替パスワード・問い合わせ（hostserver）、telnet の暗号化と受信の保留（tn5250）、配線（server）。
      対象: `hostserver/src/bypass-signon.ts` `signon.ts` `tn5250/src/telnet/telnet.ts` `session/*.ts` `server/src/session-manager.ts`
      依存: T1
      AC: AC1, AC2, AC3
- [x] T3: テスト・mutation・実機・文書。
      対象: `test/bypass-signon.test.ts` `telnet.test.ts` `bypass-substitute.test.ts` `scripts/verify-autosignon.mjs` `docs/PROTOCOL.md` `README.md`
      依存: T2
      AC: AC4
