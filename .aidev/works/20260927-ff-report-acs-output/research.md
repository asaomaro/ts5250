# 調査: FF だけの帳票の ACS の実出力

## 判明した事実
- F1（試行。2026-09-27）: scratchpad に `ECLHostPrintSession`（`SESSION_TYPE`＝6・`printDestination`＝false・`printFileName`・`printSeparateFiles`）を開く Java を書き、社内機のプリンター装置へ繋いだ。
  - 最初は `NVT5250.getHostDeviceOptions` がプロパティの欠け（`ssoEnabled` 等）で落ち、次に `convertStringToByte` が 2 文字の値（`drawer1` 等）を要して落ちた——製品の ACS が GUI の設定から入れる値を、プローブでは全部自分で入れる必要がある。
  - 値を揃えると初期化は通ったが、`StartCommunication` から戻らず（60 秒）、帳票は書き出しプログラムに渡らなかった（スプールは READY のまま）。原因は突き止めていない（ヘッドレスの環境で印刷の初期化〔JPS〕が待つ見込み——未確認）。
  - 実機に作ったスプールは消し、書き出しプログラムを止めた（残り 0）。
- F2: したがって ACS の実出力は測れなかった。原典の読み（`20260927-printer-hold-cancel` research F6: 既定の JPS は白紙 1 ページで当 PJ と一致、PDT は単独の FF を保留）で D2 を据え置く。

## design への申し送り
- 台帳は「測る手段が確立できない」として閉じる。次に試すなら、GUI のある Windows の ACS でファイル出力に設定して同じ取り消しを行う（利用者の手が要る）。
