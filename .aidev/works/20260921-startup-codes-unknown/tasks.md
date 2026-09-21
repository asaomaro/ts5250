# タスク: 起動応答コード 2703 / 2777 / 8936 / 8937 を知らない

## 実装方針
`CODE_MEANING` に 4 エントリを足すだけ。認識はこの表のキーで駆動している。

## 作業順序と依存関係
下の `依存:` に従う。**原典の確認（T1）を先に置く**——文言を創作しないため。

## リスク / 留意点
- **それらしい英文を創作しない。** 2703 / 2777 は ACS の文言を辿れなかったので「未確認」と書く。
- 失敗コードの警告は `session rejected <code>`（成功側が `startup response <code>`）。
  **テストの期待を取り違えやすい**（実際に一度間違えた）。

## テスト方針
- 単体（`startup-record.test.ts`）: 認識・成功判定・文言。
- 結合（`startup-reject.test.ts`）: 装置名なしでも**データ扱いされない**＝`expected ESC` が出ない。
- **表から 1 行外して落ちることを確かめる**（条項 `verify-by-mutation`）。

## タスク
- [x] T1: ACS の `DS5250.processStartUpConfirmation` を原典で確認し、4 コードの扱いを記録する。
      対象: `acshod2.jar` の `com/ibm/eNetwork/ECL/tn5250/DS5250.class`（`javap -c -constants`）
      依存: なし
      AC: AC4
- [x] T2: `CODE_MEANING` に 4 エントリと出所コメントを足す。
      対象: `packages/tn5250/src/telnet/startup-record.ts` `CODE_MEANING`
      依存: T1
      AC: AC1, AC2, AC3, AC4
- [x] T3: 単体テスト（認識・成功判定・文言の形）。
      対象: `packages/tn5250/test/startup-record.test.ts`
      依存: T2
      AC: AC1, AC3
- [x] T4: 結合テスト（装置名なしでデータ扱いされない）。
      対象: `packages/tn5250/test/startup-reject.test.ts`
      依存: T2
      AC: AC2
- [x] T5: mutation で担保を確かめる（表から 1 行外して落ちること）。
      対象: `packages/tn5250/src/telnet/startup-record.ts`（一時的に外す）
      依存: T3, T4
      AC: AC5
