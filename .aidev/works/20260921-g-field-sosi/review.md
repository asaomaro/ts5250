# レビュー: G（純 DBCS）欄の SO/SI

## タスク点検ログ
- T1・T2・T3・cross: 同じセッションで差分を読み直した。指摘なし。

## ラウンド 1（同じセッション。独立点検は節目で）
- 要件適合: `aidev coverage` は tasks 承認時と同じ（gap 0）。AC1〜AC5 を実機の生バイトの単体と mutation で固定し、実機で当 PJ の送信が ACS と一致することを確かめた。
- 価値適合: G の欄が文字化けせず、ACS と同じ数の字が入り、ホストの欄に制御バイトが入らない。
- 正確性: 送信は SO/SI 無しで欄長（偶数）いっぱい・G 以外（J・E・O）の経路は変えていない。受信は DBCS のコードページだけ（`codec.decodeDbcsPair`）。`trimPad` で比較・送信・満杯判定の値を揃えた。
- 規約適合: 試験画面・診断・手順を `scripts/` に残した（測った後に `--clean` で消す）。実機の識別子・資格情報は書いていない（中継の記録は解析後に消した）。台帳の (j)・WEA5・G の SO/SI を更新し、J の別件を起票した。
- 指摘なし。

## ラウンド 2（節目 11 の独立点検。`scratchpad/rv11/review-core.md`。担当 A）
- [must] **A-M1** `packages/tn5250/src/session/session.ts` の `Session.setField` が G の欄の長さ検査に SO/SI 込みのバイト数を使っており、全角 6 字（12 バイト）を渡すとオーバーフロー扱いで拒否していた（web-ui の編集モデルは通るのに、送信が通らない）。`encodedFieldLength(value, codec, pure)` を新設し、G は `pure=true` で SO/SI 抜きの長さを数えるように直した。
- [should] **A-S1** `packages/tn5250/src/protocol/read-response.ts` の `buildFieldResponse` が継続 G（CNTFLD）の値を先頭区間の長さで切り詰め、後続区間のデータを黙って捨てていた（`4af398b5` で入った退行）。`pureValue`（区間ごとに送信長まで全角空白で詰める）と、継続欄は `buf.continuedRun(f)` の総長で切る形に直した。
- [should] **A-S2** `packages/tn5250/src/protocol/wtd-applier.ts` の DBCS 組の判定が、次のバイトを読む前に消費してしまい、奇数バイト・未閉鎖の区間で次のオーダーを誤って組の後半として食う恐れがあった（`r.peek()` を使うよう修正）。
- [should] **A-S3** `packages/tn5250/src/protocol/wtd-applier.ts` の WEA タイプ 5 の値 `0x00` を「区間を終える」と実装していたが、ACS の原典（`PS5250.writeExtAttribute` の `case 0`）は `NLSPlane[現在位置] = 0` だけで区間の旗を変えない。0x00 では区間フラグを変えないように直した。
- [should] **A-S4** 上記 4 件（A-M1・A-S1・A-S2・A-S3）を素通りさせていたテストの不足を埋めた: `Session.setField`（G の欄）の 6 バイト境界・継続 G の未編集/編集後の値・奇数バイト/未閉鎖の区間・WEA5 の 0x00 のテストを `dbcs-pure-field.test.ts` に追加（tn5250 側 8 件）。全て mutation で検出を確認（`mut-gfA.py`・`mut-gfA2.py`）。
- [should] **A-S5** 台帳・work の記録が実態より狭く書かれていた: (1) 「全角 6 字が入る」は A-M1 まで web-ui の編集モデルだけの話で送信が通らなかった、(2) 実機の確認は `かきく`（3 字）だけで欄いっぱい・継続欄・不正な区間は測っていない、(3) WEA タイプ 5 の否定応答は SBCS セッションの 0x1005012D だけでなく、値が 0x81/0x80/0x00 以外なら 0x1005012F も原典にある。台帳を直し、未確認の範囲を明記した。
- [nit] **A-N1** `test-result.md` の「tn5250 879 passed」は HEAD の実測と 3 件ずれていた（mutation で生き残ったテストを足す前の数字）。実測値（当時 882、A-S4 適用後は 890）に直した。

対応: A-M1・A-S1・A-S2・A-S3 はコードを直し、A-S4 のテストを追加して mutation で検出を確認（`Session.setField（G の欄）`・`継続入力の G の欄（A-S1）`・`純 DBCS の欄の送信の細部（A-S4）` の各 describe）。A-S5・A-N1 は記録を実態に合わせた（台帳・`test-result.md`）。

## ラウンド 3（通過）
- ラウンド 2 の指摘（must 1・should 5・nit 1）を直した。`Session.setField` の長さ検査・継続 G・奇数バイト・WEA5 の 0x00 をテストで固定し、mutation 10 通りすべて検出。台帳・test-result.md を実態に合わせた。指摘なし。
