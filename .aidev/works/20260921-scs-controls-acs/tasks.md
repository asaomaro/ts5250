# タスク: SCS の制御を ACS に合わせる

## テスト方針
- 単体: 制御ごと・2B のクラスごと。実採取の帳票の新旧比較。mutation。

## タスク
- [x] T1: 1 バイトの制御の振り分けを ACS の表にする。
      対象: `packages/scs/src/scs.ts` `decode`
      依存: なし
      AC: AC1
- [x] T2: 2B のオーダーの消費長。
      対象: `packages/scs/src/scs.ts` `skip2b`
      依存: なし
      AC: AC2
- [x] T3: テスト・新旧比較・mutation。
      対象: `packages/scs/test/scs.test.ts`
      依存: T1, T2
      AC: AC3
