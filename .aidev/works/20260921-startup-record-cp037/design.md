# 仕様: 起動応答を CCSID 37 で読む

## 設計方針
- `parseStartupResponse` から codec の引数を外し、中で CCSID 37 の codec を使う（呼び出し側が取り違えられない形にする）。
- 起動応答の解析はブラウザ入口に出していないので、37 の表を足してもバンドルは増えない。

## 依拠する既存の事実
- research F1〜F3。

## 受け入れ基準との対応
- AC1: `test/startup-record.test.ts`（930 の codec なら化ける前提と、`$` のまま）・`test/startup-reject.test.ts`（930 のセッションの警告の装置名）
- AC2: mutation（codec を 930 にすると 2 件落ちる）
