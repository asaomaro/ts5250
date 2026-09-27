# レビュー: キー編集の細部の残り

## ラウンド 1（全体レビュー・タスク点検を兼ねた委譲）
- [must][conv:-] `packages/tn5250/src/session/session.ts` Test Request を施錠中も通していた（ACS は施錠中は捨てる）/ 対応: 施錠中は送らず、送ったら施錠して待つ（decisions D3）。テストを逆にした
- [should][conv:paired-artifact-sync!] `packages/web-ui/src/composables/useKeymap.ts`・`session-controller.ts`・server の `flagKey` で Test Request の扱いが食い違い / 対応: Test Request はフラグのキーに入れず（施錠中は通さない）、検査だけ外す形に揃えた
- [should][conv:-] `EmulatorPane.vue` 3270 で Alt+Pause が PROTOCOL_ERROR / 対応: `canSendAid` で 3270 の Test Request を塞いだ
- [should][conv:-] `EmulatorPane.vue` エラー中の Alt+@ がエラーを抜けて字を打つ / 対応: 文字の割当を文字キーとして拒否（`isEditingKey`）
- [should][conv:-] `useKeymap.ts` 欄の外の文字の割当が無言で消える / 対応: 普通の文字と同じく 0005（`isProtectedEdit`）
- [should][conv:verify-by-mutation!] `test/acs-default-keys.test.ts` alt+Pause の既定のテストが無い / 対応: 足した
- [should][conv:verify-by-mutation!] `buffer.ts` `cursorInputOnly` の SAVE/RESTORE のテストが無い / 対応: 足した
- [should][conv:measurement-sanity!] PA2 と E・O 欄の Home を測っていない / 対応: PA2 は ACS と当 PJ の両方で測った（`070c6e`）。E・O 欄の Home は未確認と明記（decisions D2）
- [should][conv:-] `docs/HLLAPI.md` に PA を断ると書いたまま・README の既定キーの一覧 / 対応: 直した（`docs/PROTOCOL.md` に TRQ も）
- [should][conv:-] `scripts/.tmp-readlog.mjs` が残っていた / 対応: 消した
- [nit][conv:comment-provenance!] 版 4 のコメント「Test Request などは未対応」/ 対応: 取り消し線
- [nit][conv:-] `char:` を画面で作れない / 対応: decisions D1 に未対応として残した
- [nit][conv:-] 投げ直しの bubbles:true・循環 / 対応: bubbles:false にし、1 段で止めた
- [nit][conv:-] CSRINPONLY で窓の閉じ込めを解かない / 対応: 解いた（ACS `unrestrictWindowCursor`）
- [nit][conv:-] SO が最終桁のときに巡回しない / 対応: 次の行の 1 桁目へ
- [nit][conv:measurement-sanity] CSRINP は 1 回 / 対応: 2 回目を取った（同じ 8 か所）
- [nit][conv:-] Erase Input の SO の +1 / 対応: 当 PJ の列ビューでは同じになる（decisions D2）

## ラウンド 2
- 前ラウンドの指摘は解消（全スイート緑・変異がそれぞれ落ちる・実機 pass=5）。このラウンドの差分に must/should なし
