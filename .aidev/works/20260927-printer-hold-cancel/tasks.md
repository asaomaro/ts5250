# タスク: プリンターの応答を止めている間にホストが帳票を取り消したとき

## 実装方針
テスト 1 件と測定スクリプト。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 測定スクリプトの出力に装置名が出る（`<PRTDEV>` に置き換えて記録する。スクリプト自体は環境変数から採る）。

## テスト方針
- `packages/tn5250/test/printer-session.test.ts` を回す。

## タスク
- [x] T1: 実測した並びのテスト
      対象: `packages/tn5250/test/printer-session.test.ts` の describe「respondAfter」 / 根拠: research A2
      依存: なし
      AC: AC2
- [x] T2: 測定スクリプト（取り消し 2 通り・アイドル）
      対象: `scripts/verify-printer-hold-cancel.mjs`
      依存: なし
      AC: AC1, AC3, AC4
