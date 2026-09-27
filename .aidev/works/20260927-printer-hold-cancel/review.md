# レビュー記録: プリンターの応答を止めている間にホストが帳票を取り消したとき

## タスク点検ログ
- [should][conv:comment-provenance] T1 printer-session.test.ts: FF だけの帳票を出すことを、未決（D2）の現状と書かずに固定している / 対応: 未決の現状を写しただけと D2・backlog を添えた
- [should][conv:measurement-sanity] T1 printer-session.test.ts: 3 本目の CLEAR が止めている間に届いたかは research から裏が取れない / 対応: 測り直して解いた後に届くと確かめ（research F2）、テストも解いた後に流す形にした
- [nit][conv:comment-provenance] T1: 出所のスクリプトが未追跡 / 対応: 同じコミットに入れる
- [should][conv:-] T2 verify-printer-hold-cancel.mjs: ログに利用者名（JOB の修飾名）が出る / 対応: 装置名と利用者名を `mask` で伏せる
- [should][conv:-] T2: 片付けが try/finally でない / 対応: finally で切断・書き出しプログラムを止める・スプールを消す
- [should][conv:-] T2: 開始前からあったスプールまで拾う・消す / 対応: 開始前の集合を控えて除いた
- [should][conv:measurement-sanity] T2: アイドルのモードでも「取り消して 10 秒」と出る / 対応: ラベルを分けた
- [nit][conv:-] T2: 答えた CPA4044 に繰り返し答える / 対応: 答えた鍵を控える
- [nit][conv:-] T2: モンキーパッチの再投入の注意・flag1 の欄 / 対応: コメントと欄を足した
- [nit][conv:-] T2: warn が伏せられない・書き出しプログラムの状態を戻さない / 対応: log が伏せる・戻さない旨をコメント

## ラウンド 1
- [should][conv:-] research.md F6: 「ACS の実際の出力は測れていない」は原典の読みが `PSNVT5250P` で止まっていたための空白 / 対応: `PrintSCS5250JPS`（既定）は白紙 1 ページ・PDT は保留、と経路ごとの事実に直した
- [should][conv:-] research.md F6 / test-result: 「GUI 無しで動かす手段が無い」は確かめていない断定 / 対応: `ECLHostPrintSession` で当てられるかは未確認、と書き直した
- [should][conv:-] decisions.md D2: 根拠が上の 2 点の空白に乗っている / 対応: 既定（JPS）と一致するので変えない、に書き直した
- [nit][conv:-] research.md F2: CLEAR の数え方がテストと揃っていない / 対応: 揃えた
- [nit][conv:-] verify-printer-hold-cancel.mjs: 帳票が届かないときも取り消しを発行する / 対応: その回を打ち切る

## ラウンド 2
- 前ラウンドの 5 件の解消を確認（F6・D2・test-result・F2 の数え方・打ち切り。printer-session.test.ts 22 件が緑、スクリプトは構文検査）。このラウンドの差分に must/should は無い
