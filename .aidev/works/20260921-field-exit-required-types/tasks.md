# タスク: Field Exit 必須の欄を ACS と同じく扱う

## 実装方針
原典の判定をそのまま関数にし、自動送りの 2 か所と 0020 の待ちに当てる。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既存の FER の自動送りのテストと、0020 のテストを壊さない。

## テスト方針
- 自動送りしないこと（ScreenGrid）と、Enter が通る／止まること（ペイン）。mutation。

## タスク
- [x] T1: 判定の関数と、自動送り・Dup への適用。
      対象: `mandatoryCheck.ts` `isFieldExitRequired`、`ScreenGrid.vue` `advanceIfFull` `dupKey`
      依存: なし
      AC: AC1
- [x] T2: 右端の境界で 0020 の待ちを外す。
      対象: `EmulatorPane.vue` の 0020 の待ちの監視
      依存: T1
      AC: AC2
- [x] T3: テストと mutation、② の誤った記述の訂正。
      対象: `ffw-behavior-bits.test.ts` `aid-field-exit-required.test.ts`
      依存: T2
      AC: AC3
