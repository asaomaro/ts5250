# レビュー: CLEAR 系と CA キーの申告

## タスク点検ログ
- [nit][conv:comment-provenance!] T1 `clearUnit` の注記「ホストは SOH を送り直す」が未確認なのに断定 / 対応: 未確認と書いた
- [should][conv:measurement-sanity!] T2 直した後の実機の結果が無い / 対応: research F4・test-result に記録（pass=3）
- [should][conv:measurement-sanity!] T2 ACS の実測が 1 回 / 対応: CACUA・CACFT を取り直して同じ値（research F2）
- [nit][conv:verify-by-mutation] T2 変異の記録 / 対応: 2 通り落ちると記録
- [nit][conv:-] cross 台帳の同期 / 対応: deliver で割った

## ラウンド 1
- 上と同じ（REVIEW 節）。must なし。should 2 件は対応済み
