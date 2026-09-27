# レビュー: READ の無い WRITE ERROR CODE

## タスク点検ログ
- [must][conv:-] T1 後の WEC が溜めた AID を捨てず、READ で古い AID を送った / 対応: WEC で捨てる（ACS `initKeyboard`）。ACS の実測（research F4）でも捨てると確かめた
- [should][conv:-] T1 `pending_read` の立て下ろしが ACS と違う箇所が書かれていない / 対応: CC1 の施錠で捨てる・WEC で下ろすを入れ、残りは decisions D2 とコメントに書いた
- [should][conv:-] T1 RESTORE で戻さない / 対応: 未対応として D2 に書いた
- [nit][conv:-] T1 溜めた AID の送信の例外を拾わない・時間切れでも残る / 対応: try で拾い、JSDoc に時間切れの扱いを書いた
- [should][conv:verify-by-mutation!] T2 分岐の `return` などの変異が生き残る / 対応: 施錠と待ちの検査・2 回目の WEC・CC1・Attn のテストを足し、5 つが落ちることを確かめた
- [should][conv:measurement-sanity!] T2 ACS の実測が 1 経路 1 回 / 対応: 2 経路目（WECTWICE）を 3 回測った
- [should][conv:measurement-sanity] T2 直した後の実機の結果が無い / 対応: test-result.md に記録
- [nit][conv:-] T2 最初の待ちが解けたかを判定していない / 対応: 判定に入れた
- [should][conv:-] cross Attn / SysReq で溜めた AID が残る / 対応: 捨てる（D2。ACS は未確認）

## ラウンド 1
- 上と同じ指摘（REVIEW 節）。must 1・should 4 はすべて対応済み
