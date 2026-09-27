# レビュー記録: EA の扱い

## タスク点検ログ
- [should][conv:-] T1 wtd-applier.ts: 行き先が最後の桁のとき次の書き込みが画面の外になり、例外でレコードを捨てる（退行の余地）/ 対応: ACS を実測し（research F4）、画面の終わりを越える並びは書かずに 0x10050121 で戻す（D2）
- [nit][conv:-] T1 0xFF の DBCS の区間の印をコメントに書いていない / 対応: 書いた
- [nit][conv:-] T1 タイプの誤りに EA_LENGTH の名前を流用 / 対応: 同じ値である旨をコメント
- [should][conv:verify-by-mutation] T2 最後の桁の境界のテストが無い / 対応: EATESTEND・OVER・ちょうど収まる・EA 24,80 で終わる形を足した
- [nit][conv:-] T2 長さ 5 の上限 / 対応: 足した
- [nit][conv:measurement-sanity] T3 verify の否定応答の拾い方が 0x1005012x だけ / 対応: 0x10xxxxxx を広く拾う
- [nit][conv:-] T3 ACS の台本の PARM が固定 / 対応: 兄弟と同じ運用（コメントどおり 1 モードずつ替える）——変えない

## ラウンド 1
- [should][conv:measurement-sanity] wtd-applier.ts: 最後の桁でちょうど終わった後の位置を割らずに残し、ACS が 1,1 に書いて受ける形を否定応答にしていた / 対応: 原典で `writeString` の割った余りを確かめ、EATESTWRAP を実測（W は 1,1）。EA の後以外は 0 に戻す（D3）
- [should][conv:comment-provenance] wtd-applier.ts・D2: 「並びの全部を書かず」は見える文字の実測だけ / 対応: 見える文字に絞り、HostPlane・属性は未確認の差として D2 に書いた
- [should][conv:paired-artifact-sync] design.md・requirements.md が D2 と T1b（画面の終わり）を含んでいない / 対応: 対象範囲・振る舞い・完了条件を広げた
- [nit][conv:-] dscmd.c の EATEST のコメントに EATESTOVER が無い・字下げ / 対応: 直した
- [nit][conv:-] ea-acs.txt・README のモードが 4 つだけ / 対応: 7 つにした

## ラウンド 2
- 前ラウンドの 5 件の解消を確認（実機 7 通りで pass=25・tn5250 995 件が緑）。このラウンドの差分に must/should は無い
