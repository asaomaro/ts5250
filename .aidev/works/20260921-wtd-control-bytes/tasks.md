# タスク: 制御バイトを表示データにする

## テスト方針
- 単体（`wtd-applier.test.ts`）。旧い「未知オーダー」のテスト 2 件を書き換える。mutation。実機は変更前に測った（research F2・F3）。

## タスク
- [x] T1: 分岐の追加と `default:`・`isKnownCommand` の撤去。
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `applyWtd` `packages/tn5250/src/protocol/constants.ts` / 根拠: research A1・A2
      依存: なし
      AC: AC1, AC2, AC3, AC4
- [x] T2: テストの書き換えと mutation、実機の測定の記録。
      対象: `packages/tn5250/test/wtd-applier.test.ts` `scripts/acs-probe/wtd-control-bytes.txt` `scripts/host-src/dscmd.c`
      依存: T1
      AC: AC1, AC2, AC3, AC4, AC5
