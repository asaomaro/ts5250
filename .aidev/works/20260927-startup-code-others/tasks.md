# タスク: 起動応答 I901・I902 以外のコードの扱い

## 実装方針
テストとコメントだけ。測定資産は research の時点で書いた。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- `AcsProbe.java` の出力に環境の固有名詞（システム名）を出さない（起動応答は先頭 4 字だけ）。

## テスト方針
- `packages/tn5250/test/session.test.ts`・`startup-reject.test.ts` を回す。変異: `STARTUP_SUCCESS_CODES` から I906 を外すと落ちる。

## タスク
- [x] T1: I906・表に無いコードの経路のテスト
      対象: `packages/tn5250/test/session.test.ts` の describe「起動応答レコード」 / 根拠: research A1
      依存: なし
      AC: AC1, AC2
- [x] T2: `STARTUP_SUCCESS_CODES` に ACS との関係のコメント・測定資産（AcsProbe の dump・startup-i906.txt）
      対象: `packages/tn5250/src/telnet/startup-codes.ts`・`scripts/acs-probe/AcsProbe.java`・`scripts/acs-probe/startup-i906.txt`
      依存: なし
      AC: AC3, AC4
