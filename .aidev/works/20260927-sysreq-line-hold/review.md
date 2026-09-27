# レビュー記録

## タスク点検ログ

- [must][conv:-] `packages/tn5250/src/protocol/wtd-applier.ts` ホストの CLEAR UNIT・CUA・WEC で行を閉じていない（ACS `clearSysreqMode`）/ 対応: `onClearSysReq` を足し、単体で固定
- [must][conv:-] `packages/tn5250/src/session/session.ts` 溜めの上限の抜け道が行だけの保留で効かない（`dismissHostError` が何もしない）/ 対応: 行も閉じて `releaseHeld`
- [must][conv:-] `packages/server/src/ws-handler.ts` 画面が切れる・予約が始まると行が開いたまま残る / 対応: `dispose` と `reserve` で閉じる。予約の間も close は受ける
- [must][conv:-] `packages/web-ui/src/components/EmulatorPane.vue` ペインを閉じても close を送らない / 対応: `onBeforeUnmount`
- [should][conv:-] `packages/tn5250/src/session/session.ts` RESTORE で READ の印を無条件に立てる / 対応: 退避の文脈に `readOutstanding` を入れて戻す
- [should][conv:-] `packages/tn5250/src/session/session.ts` 持ち越した CC2 を当てる時期と「点けるが勝つ」の誤り / 対応: 残りのレコードの終わりで当て、MW は後の指定が勝つ（`preprocessWCC2`）
- [should][conv:-] `packages/tn5250/src/session/session.ts` 行の間の実行キー以外の AID の扱い / 対応: 画面は 0006・コアは閉じて送る（decisions D2）
- [should][conv:verify-by-mutation] テストの穴（server の形・3270 で無視・予約／web-ui の unfocus・切断・unmount／CC2 の組み合わせ／RESTORE の対照）/ 対応: 追加し、変異で確かめた（test-result.md）
- [should][conv:measurement-sanity] LATEWTD・HOLDCC2 が 1 回の観測 / 対応: ACS を送信で閉じる経路（`sysreq-line-hold-submit.txt`）と、HOLDCC2 のワイヤ（tap）で取り直した
- [should][conv:measurement-sanity] 検証の「5 行目が空」は LATE が届く前でも通る / 対応: 溜めにあることも見る
- [should][conv:-] decisions.md が無い / 対応: 書いた
- [nit][conv:-] コメントの誤り（切断でセッションも行を忘れる）/ 対応: 直した
- [nit][conv:-] WEC（窓）で行を閉じるのが長さ検査の前 / 対応: WEC と同じく後へ
- 変異で見つけた穴（点検の後）: フッターのボタンの AID が行を素通りしていた（`StatusBar.press`）→ `sysReqOpen` を渡し 0006 に。取り消してすぐ開き直すと前の「閉じた」返事で新しい行が閉じる → 開くたびに `sysReqLineSeen` を戻す

## ラウンド 1

- [should][conv:-] `packages/server/src/ws-handler.ts` 読み取り専用のセッション（SysReq が `READ_ONLY_SESSION` で断られる）や、キーが SRQ を送る前に失敗したとき、画面は送信で行を畳み閉じる知らせを送らないので、セッションの行が開いたまま出力が止まる / 対応: `onKey` で SysReq が失敗したら行を閉じる（`closeSysReqLineQuietly`）。読み取り専用のセッションは開くを受けない。テスト 2 件・変異 2 通り検出
- [nit][conv:-] `packages/web-ui/src/components/EmulatorPane.vue` 行の間にキーボードで押した F キーは黙って捨てる（ACS は 0006 で行を閉じる）/ 対応: 既知の差として decisions D5 に記録
- [nit][conv:-] `packages/server/src/ws-handler.ts` 同じセッションに複数の接続があると、片方の取り消し・切断がもう片方の行を閉じる / 対応: decisions D5 に記録
