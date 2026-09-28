# タスク: 継続欄の O の編集を ACS と同じセルの並びで行う

## 実装方針
純関数（`oChainCells.ts`）を先に作り ACS の 12 通りで固める → core の置き場と送信 → 画面の配線 → 実機のブラウザで CONTOX を流す。

## 作業順序と依存関係
下の `依存:` に従う。純関数の単体テストが ACS のバイト列で通ってから画面へ配線する（見立てが外れたら原典を読み直す）。

## リスク / 留意点
- 値に死んだ桁の印が入るので、印を数える箇所（桁の数え方・表示）が崩れないかを単体テストで見る
- 画面の経路は O 欄（継続でない）と共有するので、#443 のテストを回す

## テスト方針
- 単体: `packages/web-ui/test/o-chain-cells.test.ts`（純関数・12 通り）、`packages/tn5250/test/o-chain-send.test.ts`（core の置き場と送信）、ScreenGrid の打鍵（`o-chain-edit.test.ts`）
- 実機: `scripts/verify-browser-cont-o.mjs`（CONTOX）

## タスク
- [x] T1: 死んだ桁の印 `DEAD_MARK` と、`OCell.dead`・`toCells`/`fromCells`・`backspaceTarget` の切り出し
      対象: `packages/web-ui/src/composables/fieldValidate.ts:169` `packages/web-ui/src/composables/oFieldCells.ts` / 根拠: research A3
      依存: なし
      AC: AC7
- [x] T2: 鎖の操作の純関数（挿入の詰め直し・上書きの区間送り・Delete・Backspace）と単体テスト
      対象: `packages/web-ui/src/composables/oChainCells.ts`（新規）・`packages/web-ui/test/o-chain-cells.test.ts`（新規）
      依存: T1
      AC: AC1, AC2, AC3, AC5
- [x] T3: core: 死んだ桁の印を NUL のセルに置き、送信で区間の境目の SI|SO を詰める。単体テスト
      対象: `packages/tn5250/src/screen/buffer.ts:1251` `setFieldCells`・`:1305` `setFieldValue`・`packages/tn5250/src/protocol/read-response.ts:181` `rawDbcsSendValue` / 根拠: research A4
      依存: T1
      AC: AC1, AC2, AC4
- [x] T4: 画面: 継続した O 欄の打鍵・挿入・Backspace・Delete を鎖の操作へ、値の印の読み・Erase の O 欄の判定を継続欄にも。単体テスト
      対象: `packages/web-ui/src/components/ScreenGrid.vue` の `isOCells`・`dbcsType`・DBCS の keydown（`:3352`〜`:3470`）・`logicalFromCells`・`oExplicit`・`eraseToEndDbcs` / 根拠: research A1, A2
      依存: T2
      AC: AC1, AC2, AC3, AC7
- [x] T5: 実機のブラウザの検証スクリプト（CONTOX を打鍵してホストのログを ACS の値と比べる）。実行は test 工程
      対象: `scripts/verify-browser-cont-o.mjs`（新規。`scripts/verify-browser-o-field.mjs` を下敷き）
      依存: T4
      AC: AC6
