# レビュー: 解錠中の WTD と溜めた AID のカーソル

## タスク点検ログ
- [should][conv:measurement-sanity!] T1 CC1 0x20 の 1 回の測定を全 CC1 へ広げている / 対応: 0x40〜0xE0 は未確認と decisions D1・コメントに書いた
- [should][conv:measurement-sanity] T1 明示の IC のケースは外挿 / 対応: テストとコメントに外挿・未確認と書いた（decisions D2）
- [should][conv:-] T1 押したときの位置を保存する形は原典とも違い、送った後の画面のカーソルが ACS と食い違う / 対応: decisions D2 に未対応として残した（原典の条件は F2 と DSPFMT に合わず一つに書けない。独立点検の「施錠中なので 0x40」の読みは条件が逆——施錠中はカーソルを動かす側）
- [nit][conv:verify-by-mutation] T1 CC1 のテストの CC2 の変更は不要・バイト列を見ていない / 対応: CC2 を 0x00 に戻し、送った AID の先頭 3 バイトを見る
- [should][conv:measurement-sanity!] T2 `setCursor` が無く、UNLOCKWTDNOIC の PASS は区別しない / 対応: 呼び出しを外し、測れないことをスクリプトと research F2 に書いた
- [should][conv:paired-artifact-sync!] T2 README の「カーソルの 2 バイトは既知の差」が古い / 対応: 直した
- [nit][conv:-] T2 見出しの「Enter の READ も同じ位置」を検査していない / 対応: ACS の結果であることとスクリプトは見ないことを書いた
- [nit][conv:measurement-sanity] T2 どのモードを何回測ったか / 対応: 各モード 1 回と書いた

## ラウンド 1（全体レビュー）
- [must][conv:-] decisions.md が無く、前 work の D1（CC1 で捨てる）の破棄が記録されていない / 対応: decisions D1 に破棄と証拠を書き、前 work の D1 を取り消し線にした
- [should][conv:-] 台帳（345・(f)）と前 work の research F3・test-result が古い / 対応: 取り消し線で同期し、台帳に `[x]` を割った

## ラウンド 2
- 前ラウンドの指摘は解消（単体 7 件緑）。このラウンドの差分に must/should なし
