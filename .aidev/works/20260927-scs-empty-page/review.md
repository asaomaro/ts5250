# レビュー: 空ページ

## タスク点検ログ
- [should][conv:verify-by-mutation!] T1 白紙のページの HTML・PDF の描画を回帰テストで固定していない / 対応: 両方にテストを足した
- [nit][conv:comment-provenance!] T1 「（台帳）」の出所と、「合わせない候補」を決定のように書いていた / 対応: 台帳の項目名と未確認を書いた
- [nit][conv:-] T1 先頭の FF・DBCS モード中の FF のテストが無い / 対応: 足した
- [nit][conv:-] cross HTML の白紙の紙が幅 0 桁 / 対応: 帳票のいちばん広いページの幅に揃えた（ACS はジョブ共通の用紙）
- [nit][conv:-] cross FF だけの帳票の誤表示が消える副次効果 / 対応: test-result に記録

## ラウンド 1
- VERDICT pass（上の指摘は対応済み）
