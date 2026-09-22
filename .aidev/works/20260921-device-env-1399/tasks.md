# タスク: 1399 の申告

## テスト方針
- 値を単体で固定し、実機で 5250（両方）・3270（両方）・VT（PUB400）が繋がることを見る。ACS のワイヤと並べる。

## タスク
- [x] T1: ACS のワイヤ（プローブに `PROBE_CODEPAGE_KEY`）。
      対象: `scripts/acs-probe/AcsProbe.java` `scripts/acs-probe.mjs` `scripts/README.md`
      依存: なし
      AC: AC1
- [x] T2: 表の 1399。
      対象: `packages/base/src/device-env.ts`
      依存: T1
      AC: AC1
- [x] T3: テストと実機（`scripts/verify-device-env.mjs` を新設）。
      対象: `packages/base/test/device-env.test.ts` `packages/tn5250/test/terminal-wide.test.ts` `scripts/verify-device-env.mjs`
      依存: T2
      AC: AC1, AC2
