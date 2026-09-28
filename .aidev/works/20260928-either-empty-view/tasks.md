# タスク: 全角の状態の E・J の欄のカーソルの桁と End を ACS と同じにする

## 実装方針
詰め物 → 末尾の落とし方 → End → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- compact の E の見た目（SI の位置）を変えない

## テスト方針
- 単体と、実機のブラウザ（直す前に落ちることも確かめる）

## タスク
- [x] T1: full・open の E の空きを全角空白にし、末尾の全角空白を落とす（`jeWidePad`・`padDbcs`・`trimPad`）
      対象: `packages/web-ui/src/components/ScreenGrid.vue` / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T2: End で全角空白も飛ばす（J・full/open の E）
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `packages/web-ui/src/composables/fieldEdit.ts` `end` / 根拠: research A1, A2
      依存: T1
      AC: AC1
- [x] T3: 単体テスト（新規と、既存の期待の見直し）
      対象: `packages/web-ui/test/either-empty-view.test.ts`（新規）`test/dbcs-insert-room.test.ts` `test/dbcs-space-key.test.ts`
      依存: T2
      AC: AC1
- [x] T4: 実機（ACS の End のプローブ・ブラウザの検証）
      対象: `scripts/acs-probe/je-field-end.txt` `scripts/acs-probe/either-empty-type.txt` `scripts/verify-browser-either-empty-view.mjs`
      依存: T2
      AC: AC2
- [x] T5: 複数行の貼り付けで欄の途中まで埋める空白を空きの種類に合わせる（独立点検の指摘）
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `overwriteInto` `insertInto` `pasteFill`
      依存: T1
      AC: AC1
