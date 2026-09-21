# タスク: 自動サインオンの変数

## テスト方針
- NEW-ENVIRON のバイト列を単体で固定し、PUB400 で自動サインオンが通るのを見る。ACS のワイヤと並べる。

## タスク
- [x] T1: ACS のワイヤを採る（プローブに `PROBE_BYPASS_SIGNON`）。
      対象: `scripts/acs-probe/AcsProbe.java` `scripts/acs-probe.mjs` `scripts/README.md`
      依存: なし
      AC: AC2
- [x] T2: USER・IBMRSEED・IBMSUBSPW とエスケープ。
      対象: `packages/tn5250/src/telnet/telnet.ts`（`envValue`）
      依存: なし
      AC: AC1
- [x] T3: テストと実機（`verify-autosignon.mjs` を接続先で選べるようにした）。
      対象: `packages/tn5250/test/telnet.test.ts`、`scripts/verify-autosignon.mjs`
      依存: T2
      AC: AC1, AC2
