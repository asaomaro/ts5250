# タスク: READ の欄データの加工

## 実装方針
design のとおり。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 符号付き数値の既存テストの期待値が変わる（ACS に合わせて更新する）

## テスト方針
- 単体（ACS の実測値）とセッション、実機の検証スクリプト、変異

## タスク
- [x] T1: `FieldDataForm` と `sendValue`・0x82 の応答・セッションの選択
      対象: `packages/tn5250/src/protocol/read-response.ts`・`packages/tn5250/src/session/session.ts` / 根拠: research A1・A2
      依存: なし
      AC: AC1
- [x] T2: テスト（ACS の値・セッション・符号付き数値の更新）と実機の検証スクリプト
      対象: `packages/tn5250/test/read-alt-raw.test.ts`・`read-input-fields.test.ts`・`signed-num-transmit.test.ts`・`scripts/verify-read-alt.mjs`・`scripts/acs-probe/read-alt.txt`・`scripts/host-src/dscmd.c`
      依存: T1
      AC: AC1, AC2
- [x] T3: 実機で当 PJ を当て、片付ける（test 工程で消化）
      対象: `scripts/verify-read-alt.mjs`
      依存: T2
      AC: AC2, AC3
