# レビュー記録

## ラウンド 1

- [must][conv:-] `packages/tn5250/src/screen/buffer.ts` 空にした E 欄に SO を置くのをコアの状態だけで決めている——画面で半角に切り替えてから空にしたとき ACS は何も送らないのに `0e` を送る / 対応: 取り下げ、台帳に残した（decisions D1）
- [should][conv:-] `buffer.ts` 空白だけの値でも SO を置く / 対応: 上と一緒に取り下げ
- [should][conv:-] `packages/web-ui/src/components/ScreenGrid.vue` `firstRejection` が切り替えた後の状態を持ち回らない（空白が続くと元の状態で判定） / 対応: `eitherPasteStep` で状態を持ち回る
- [should][conv:-] `ScreenGrid.vue` 全角の状態で飛ばした桁を半角の空白で詰めて SO/SI を割る / 対応: 今の状態の空白で詰める
- [should][conv:-] `ScreenGrid.vue` 挿入の貼り付けの「何も貼らない」を ACS と書いている（ACS はそれまでの字を残す） / 対応: 意図した差として注記（decisions D2）
- [should][conv:comment-provenance!] `ScreenGrid.vue` 出所の work 名が実在しない（`20260927-either-paste`） / 対応: `20260927-either-field-rest` に直した
- [nit][conv:-] 組み立ての途中で `eitherSwitched` を書き、中断しても残る / 対応: 対応しない（中断は何も書かない経路で、次の打鍵の状態は値の先頭の字が優先する）
- [nit][conv:-] 0061 の枝の細部は未確認と書く / 対応: decisions D3
- [nit][conv:-] コアのテストの docstring の読み取りの形 / 対応: テストごと取り下げ
