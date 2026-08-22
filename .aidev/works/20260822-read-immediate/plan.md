# 計画

1. 原典 2 つ（tn5250 / tn5250j）を clone して該当箇所を読む
2. 一致点を確定し、割れている点を記録する
3. `buildReadImmediateResponse` を足す（`buildReadMdtResponse` と欄の選び方だけ違うので共通化）
4. `wtd-applier` に受け口（`readImmediateRequested`）、`session` から即送信
5. 試験（builder 6・受け口 3・セッション 1）
6. 古くなった試験（「応答していない」を固定していたもの）を更新
