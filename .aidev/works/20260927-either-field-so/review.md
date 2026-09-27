# レビュー記録

## ラウンド 1

- [should][conv:-] `packages/web-ui/src/components/ScreenGrid.vue` `eitherSwitched` が 1 つだけで、別の E 欄の切り替えで前の欄の状態が消え、状態を送るようになって誤ったバイトになる / 対応: 欄ごとの `Map` にした（decisions D4）・2 欄のテスト
- [should][conv:verify-by-mutation] `packages/tn5250/src/screen/buffer.ts` 空白だけの値では空白の桁が残り `0e 40 40 …` を送る。テストは桁の種類しか見ていない / 対応: 残りの桁を NUL にし、READ のバイトで確かめた
- [should][conv:measurement-sanity] Erase Input は状態を添えず、ACS の振る舞いも未測定 / 対応: ACS のコアで測り（E 欄は `0e`・J 欄は `0e`＋NUL＋`0f`）、Erase Input も添え、J 欄も直した（decisions D3）
- [nit][conv:verify-by-mutation] セッションのテストの「半角」の場合は直す前でも通る / 対応: 状態の旗が半角に落ちることも見る
- [nit][conv:-] `packages/server/test/ws-handler.test.ts` 新しいテストが既存の JSDoc とそのテストの間に入った / 対応: 移した
- [nit][conv:-] 継続欄の中間の区間に SO を置きうる / 対応: 先頭の区間だけにした・テスト
- [nit][conv:comment-provenance] コードのコメントに経緯を書いている / 対応: 経緯は decisions へ、コメントは ACS の事実だけにした
