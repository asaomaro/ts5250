# レビュー: 再順序付け

## タスク点検ログ
（指摘なし）

## ラウンド 1（独立レビュー・サブエージェント）
- [should][conv:verify-by-mutation!] packages/tn5250/test/resequence.test.ts:77 「SOH の本体が 3 バイト未満」の分岐を通していない（`>= 3` を `>= 1` にしても落ちない） / 対応: 本体 2 バイトの SOH の試験を足す
- [should][conv:verify-by-mutation!] 同 :81 リセットの試験が CLEAR UNIT だけ（CUA・CFT・退避と復元が無い）。0x82・0x83 も呼んでいない / 対応: 足す
- [should][conv:-] 同 :44 「ACS の実測」の describe に原典の読み・独自の判断が混ざる / 対応: 出所を書き分ける（番号 0・一巡は当 PJ の判断）
- [nit][conv:-] packages/tn5250/src/screen/buffer.ts `hasMdt` は継続欄の全区間を見るが、ACS が辿った先の区間だけを見るかは未確認 / 対応: 注記
- [nit][conv:-] 同 番号を番地の順で数える根拠 / 対応: 注記（decisions D3）

## ラウンド 2
- 前ラウンドの 5 件の解消を確認（SOH の本体 3 バイト未満・CUA・CFT・退避と復元・0x82・0x83 の試験を足して変異で検出、出所の書き分け、継続欄の MDT と番号の数え方の注記）。このラウンドの差分に must/should なし
