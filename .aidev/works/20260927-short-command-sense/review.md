# レビュー記録: 長さの足りないコマンドの否定応答

## タスク点検ログ
- [should][conv:-] T1 `20260926-wec-msgline-row` decisions D4: 上書きしたのに取り消し線・破棄先が無い / 対応: 取り消し線と破棄先・証拠を書いた。wtd-applier.ts のコメントも範囲を直した
- [nit][conv:comment-provenance] T1 tooShort の JSDoc が原典の読みまで実測として書いている / 対応: 実測と原典を書き分けた
- [nit][conv:-] T1 閾値は ACS と一致（確認結果）/ 対応: なし
- [nit][conv:verify-by-mutation] T2 READ は 0x52 だけ / 対応: 0x42・0x82 も回す
- [nit][conv:-] T2 0x22 の 0 バイトのテストの systemMessage の検査は常に真 / 対応: 位置・メッセージ行が変わらないことも見る
- [nit][conv:-] T2 末尾の空行 / 対応: 消した
- [should][conv:measurement-sanity!] T3 0x22 の 0 バイトを実機で出させずに D4 を覆していた / 対応: SHORTWECW を足して測った（ACS のコアも当 PJ も否定応答）
- [nit][conv:-] T3 否定応答の判定が奇数桁でも一致する / 対応: 偶数桁でだけ照合
- [nit][conv:measurement-sanity] T3 ACS の台本が続けて流す形のまま / 対応: 1 モードだけにして PARM を替える形に

## ラウンド 1
- [should][conv:measurement-sanity!] wtd-applier.ts の JSDoc・テストのコメント・test-result: ACS の否定応答（CPFA303）を確かめていたのは SHORTWEC・SHORTWECW だけ / 対応: WTD・READ・ROLL も ACS のコアで流し直し、dscmd.log で 3 通りとも CPFA303 を確かめて research F2 に足した
- [nit][conv:-] scripts/README.md の一覧に 2 本（early-return-cc2・short-command-sense）が無い / 対応: 足した
- [nit][conv:-] research F2・F3 の数え方が揃っていない / 対応: 5 通りに揃えた

## ラウンド 2
- 前ラウンドの 3 件の解消を確認。このラウンドの差分に must/should は無い
