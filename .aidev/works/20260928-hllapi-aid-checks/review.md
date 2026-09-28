# レビュー: HLLAPI の AID の前の検査

## タスク点検ログ
（指摘なし）

## ラウンド 1（独立レビュー・サブエージェント）
- [should][conv:-] packages/server/src/hllapi.ts:730 `aidCheck` がキーボードの施錠より先に走り、施錠中でも違反があればカーソルを動かして rc=5 を返す（ペインは施錠を先に見る。ACS の `keyDown` は施錠中の AID を受けない） / 対応: 施錠中は検査しない（従来の経路に任せる）。テストを足す
- [nit][conv:-] packages/server/src/hllapi.ts:738 除外キーの出所の書き方 / 対応: `processAIDCode` の 243・189・248・61 と書き分ける
- [nit][conv:-] packages/server/src/hllapi.ts:745・docs/HLLAPI.md エラー 32 と 0020 の番号の体系 / 対応: 内部の 32（0x20）が表示の 0020 と添える
- [nit][conv:-] packages/server/test/hllapi.test.ts 自己点検のテストがカーソルを確かめていない・カーソルの無い欄の自己点検のテストが無い / 対応: 足す
- [nit][conv:-] Print・PA1〜3 を検査するかは原典で確かめていない / 対応: ペインと同じ扱いであることと未確認を注記
- [nit][conv:-] scripts/verify-hllapi-tab-mandatory.mjs 「何も打たずに @E」は rc だけで、届いたかを見ていない / 対応: 未検証の穴に残す（ADJPGM は Enter で描き直すだけで、画面から届いたかを区別できない）

## ラウンド 2
- 前ラウンドの 6 件の解消を確認（施錠中は検査しない＋テスト・変異で検出、出所・番号・未確認の注記、自己点検のカーソルとカーソルの無い欄のテスト、実機の未検証の穴）。このラウンドの差分に must/should なし
