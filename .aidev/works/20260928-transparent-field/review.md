# レビュー: 透過の欄

## タスク点検ログ
（指摘なし）

## ラウンド 1（独立レビュー・サブエージェント）
- [should][conv:-] packages/tn5250/src/protocol/read-response.ts `transparentBytes` が字を符号化し直し、セルの元のバイトを使っていない（0x1C・0x1E のセルが `*`・`;` で出る。ACS `getFieldContents` は HostPlane のまま） / 対応: `hostByte ?? rawByte` を優先し、セルごとに組む
- [should][conv:-] 同 1 桁が 1 バイトにならない字で区間の長さとバイト数が合わず、平たい形で後ろの欄がずれる / 対応: 全角はセルの 2 桁に 1 バイトずつ割り、区間ごとに長さを固定する
- [should][conv:-] read-response.ts READ INPUT 系の注記に「未確認」が無い / 対応: 注記する
- [should][conv:-] test/transparent-field.test.ts 0x72・0x83・継続欄・DBCS の原本・0x1C の試験が無く、下位バイトの試験が弱い / 対応: 足す・完全一致にする
- [nit][conv:-] wtd-applier.ts 0x86 の単独の `if` と else-if の連なりが読みにくい / 対応: 注記を足す
- [nit][conv:-] 中間・最終の区間にだけ 0x84 が付いた継続欄の扱いは未確認 / 対応: test-result の未検証の穴へ
- [nit][conv:-] save-screen.ts の SF の組み直しは DBCS の FCW しか書かない（既存。復元は預けた画面から戻すので当 PJ の中では落ちない） / 対応: 台帳へ

## ラウンド 2
- 前ラウンドの 7 件の解消を確認（セルごとに元のバイトで 1 桁 1 バイト・変異で検出、READ INPUT 系の「未確認」の注記、0x72・0x83・継続欄・0x1C・下位バイトのテスト、else-if の注記、未検証の穴・台帳への追記）。このラウンドの差分に must/should なし
