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
- [x] T4: 独立点検の指摘を実機の ACS で測る（満杯の後・符号付き・Dup・エラー中の編集キー）。
      対象: `scripts/acs-probe/field-exit-full.txt` `scripts/build-ulktest.mjs`（DUP の画面）
      依存: T3
      AC: AC2, AC4, AC5
- [x] T5: 最終桁に留めて「出た」状態を持つ。Backspace の経路の待ち。Dup を ACS の形へ。
      対象: `ScreenGrid.vue` `fieldExitedIndex` `dupKey` `fieldExitKey` `fieldSignKey`、`EmulatorPane.vue` `noteFieldTyped`、`opMessages.ts` `MSG_FIELD_EXIT_KEY_INVALID`
      依存: T4
      AC: AC2, AC4, AC5
- [x] T6: テストの書き換え・追加と mutation。
      対象: `aid-field-exit-required.test.ts` `field-sign-dup.test.ts`
      依存: T5
      AC: AC3
