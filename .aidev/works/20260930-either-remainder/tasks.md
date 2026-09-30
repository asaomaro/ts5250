# タスク: E 欄の残り

## 実装方針
実機の ACS のコアで測る → 差を web-ui の 3 か所で直す → 実機のブラウザで確かめる。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 伏せ字の欄に IME を通す（実値を DOM に出さないことをテストで固定）

## テスト方針
- コンポーネント（ペイン全体のキー・貼り付け）、変異、実機のブラウザ

## タスク
- [x] T1: 実機の ACS のコアで測る（DSM の EITHERX・EITHERI、プローブ 2 本）
      対象: `scripts/host-src/dscmd.c` `scripts/acs-probe/either-remainder.txt` `scripts/acs-probe/either-insert.txt`
      依存: なし
      AC: AC4
- [x] T2: Dup をバイトで埋める
      対象: `packages/web-ui/src/composables/fieldEdit.ts` `packages/web-ui/src/components/ScreenGrid.vue` `dupKey`
      依存: なし
      AC: AC2
- [x] T3: E の挿入の余地（打鍵・貼り付け）
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `insertBudget` `dbcsType` `insertInto`
      依存: なし
      AC: AC3
- [x] T4: 伏せ字の DBCS 欄の編集
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `isDbcsEdit` `syncDbcs` `onCompositionStart`
      依存: なし
      AC: AC1
- [x] T5: テストと実機のブラウザ検証
      対象: `packages/web-ui/test/either-remainder.test.ts`（新規）`scripts/verify-browser-either-remainder.mjs`（新規）
      依存: T2, T3, T4
      AC: AC1, AC2, AC3, AC4
