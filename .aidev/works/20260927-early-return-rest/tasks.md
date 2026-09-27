# タスク: その場で戻る否定応答の残り

## 実装方針
core の 3 か所・テスト・実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- READ の CC1 を効かせていたテストが無いかを全件で確かめる。

## テスト方針
- tn5250 全件・新しいテスト・実機。

## タスク
- [x] T1: READ の CC を読み飛ばす・引数の無い CUA を 0 として消す・`earlyReturn`
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` / 根拠: research A1
      依存: なし
      AC: AC1, AC2
- [x] T2: SAVE PARTIAL の応答の持ち越し
      対象: `packages/tn5250/src/session/session.ts` / 根拠: research A2
      依存: T1
      AC: AC1, AC2
- [x] T3: テストと実機の検証・片付け
      対象: `packages/tn5250/test/early-return-rest.test.ts`・`scripts/host-src/dscmd.c`・`scripts/acs-probe/early-return-rest.txt`・`scripts/verify-early-return-rest.mjs`・`scripts/README.md`
      依存: T1, T2
      AC: AC1, AC2, AC3
