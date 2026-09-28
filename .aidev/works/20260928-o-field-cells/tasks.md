# タスク: O 欄の編集をセルの並びで行う

## 実装方針
土台（明示の並びの計算・コアの送信）→ 純関数 → ScreenGrid の配線 → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- E・J・G 欄と継続した O 欄の振る舞いを変えない（印を持たない値は従来どおり）
- ScreenGrid の O 欄の経路（貼り付け・選択・IME）で印を壊さない（壊れたら `normalizeO`）

## テスト方針
- 単体（純関数・コア・ScreenGrid のコンポーネント）・mutation・実機（ACS のコアとブラウザ）

## タスク
- [x] T1: 明示の並びの桁数・列ビュー（web-ui）と送信・セルの置き方（コア）
      対象: `packages/web-ui/src/composables/fieldValidate.ts`・`packages/tn5250/src/protocol/read-response.ts` `writeValue`・`packages/tn5250/src/screen/buffer.ts` `setFieldCells`
      依存: なし
      AC: AC3
- [x] T2: 純関数 `oFieldCells.ts`
      対象: `packages/web-ui/src/composables/oFieldCells.ts`（新規）
      依存: なし
      AC: AC1, AC2
- [x] T3: ScreenGrid の O 欄を印入りの値とセルの操作に回す（打鍵・挿入・Delete・Backspace・Erase EOF・Field Exit・カーソル）、独自の操作の正規化
      対象: `packages/web-ui/src/components/ScreenGrid.vue`
      依存: T1, T2
      AC: AC1, AC2, AC4
- [x] T4: 実機（ACS のコアの測定・ブラウザでの打鍵）
      対象: `scripts/host-src/dscmd.c` OEDIT・`scripts/acs-probe/o-field-edit.txt`・`scripts/verify-browser-o-field.mjs`（新規）
      依存: T3
      AC: AC3
