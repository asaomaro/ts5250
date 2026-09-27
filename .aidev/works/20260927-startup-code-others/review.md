# レビュー記録: 起動応答 I901・I902 以外のコードの扱い

## タスク点検ログ
- [should][conv:-] T1 session.test.ts: 「先頭 4 バイトだけ差し替える」は誤読を招く（差し替えるのはオフセット 16 の応答コード）/ 対応: 書き直した
- [nit][conv:comment-provenance] T1 session.test.ts: オフセット 16 の由来が無い / 対応: `6 + record[6] + 5` を書いた
- [should][conv:measurement-sanity] T2 startup-i906.txt: 前提「*FRCSIGNON なら I906」が実測（I902）と食い違う / 対応: 実測と未確認を書いた
- [nit][conv:-] T2 startup-codes.ts: 「I901・I902 以外では開始しない」は印 0x90 の起動応答に限る / 対応: 限定を書いた（research F2 も）
- [nit][conv:comment-provenance] T2 AcsProbe.java: 同じ限定漏れ・出さない理由がずれている / 対応: 直した
- [nit][conv:-] T2 startup-i906.txt: 自動サインオンと `signon` の併用は *VERIFY の機械で危ない / 対応: *FRCSIGNON 専用と明記した

## ラウンド 1
- [should][conv:-] decisions.md:6 「ACS で装置名が効くのは窓の題名だけ」は原典と合わない（状態 7 で `workstationIDReady`・`SetWorkstationID` は NEW-ENVIRON DEVNAME の読み手もいる）/ 対応: research F2・F4 と D1 を事実に合わせて直した
- [should][conv:measurement-sanity!] decisions.md:5 情報を捨てる例外の実測の裏づけが無い / 対応: D1 を暫定とし、backlog の未確認と結び付けた。当 PJ の実益（`session-manager.ts` のジョブ名）を根拠に足した
- [should][conv:-] research.md:12 ACS は下位 4 ビットの数字で分岐し、当 PJ は文字列で判定するので「表に無いコード」の集合が違う / 対応: research F7 と D1 に限定を書いた
- [nit][conv:comment-provenance] startup-codes.ts:7 「振る舞いが揃う」は画面の処理が続く点だけ / 対応: 絞った
- [nit][conv:-] AcsProbe.java:84 wsidReady は状態 7 で立つ印 / 対応: 書き直した

## ラウンド 2
- 前ラウンドの 5 件の解消を確認（research F2・F4・F7、D1 を暫定に、コメント 2 か所。javac と session.test.ts が緑）。このラウンドの差分に must/should は無い
