# レビュー記録: WTD の中のオーダーの誤り

## タスク点検ログ
- [should][conv:-] T1 wtd-applier.ts TD: 長さが画面を超える TD の ACS の分岐（TD の位置で抜け、コマンドのループが「ESC が無い」で戻る＝CC2 を落とす）を写していなかった / 対応: `abort` を返して `abortRecord` で戻す。テストを足した（原典の読み。実機では出させていない）
- [nit][conv:-] T1 SOH の本体が 1 バイト足りない形は ACS がレコードの外を読む / 対応: 差をコメントに残した
- [nit][conv:-] T1 SBA 1,0 のコメントが条件付きであることを書いていない / 対応: 書いた
- [nit][conv:-] T1 applySf などに ACS が受ける形で落ちる例外が残る / 対応: backlog
- [nit][conv:-] T1 上記以外は ACS と一致（確認結果）/ 対応: なし
- [should][conv:verify-by-mutation] T2 EA の長さ 6 の境界が無い / 対応: 6 と 0 を足した
- [nit][conv:verify-by-mutation] T2 レコードの終わりにちょうど収まる・1 バイト足りない境界が無い / 対応: EA・SOH・TD で足した
- [nit][conv:verify-by-mutation] T2 行 25・SBA 5,0 が無い / 対応: 足した
- [nit][conv:-] T3 verify のモードの書式・コマンド行が無いとき / 対応: 対応表から補い、知らないモードは exit 2・コマンド行が無ければ FAIL
- [nit][conv:comment-provenance] T3 verify のコメントが 0x10050121 固定 / 対応: 直した
- [nit][conv:-] T3 dscmd.c が知らない接尾辞で SBA を流す / 対応: 知らないモードは終わる

## ラウンド 1
- [should][conv:-] scripts/README.md に verify-wtd-order-sense.mjs が無い / 対応: 足した
- [nit][conv:-] research F1 の「SOH の長さのバイトが無い → 0x121」は原典どおりでない（ACS はレコードの外を読む）/ 対応: research・コメント・テスト名を当 PJ の決めと書き直した
- [nit][conv:-] EA の属性タイプを検査していない（ACS は 0x00・0xFF〔DBCS は 0x05〕以外で 0x1005012D）/ 対応: backlog
- [nit][conv:-] EA の後の書き始めが ACS（行き先の次）と違う（既存の差）/ 対応: backlog（実機で確かめてから）

## ラウンド 2
- 前ラウンドの 4 件の解消（または backlog 送り）を確認。このラウンドの差分に must/should は無い
