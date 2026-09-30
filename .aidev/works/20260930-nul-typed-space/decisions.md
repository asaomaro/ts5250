# 決定記録

## D1: 継続した O 欄の鎖の仕組みをそのまま全 O 欄へ広げる（J・E は別の work）
- 背景: 鎖は `20260930-cont-o-nul` で「値の U+0000＝空き・U+0020＝空白」を持たせ、実機で一致した。継続でない O 欄は空きも空白も半角空白で持ち、末尾の空白を落としていた（実測 F1〜F3）
- 決定: 条件を `isOChain`／`field.continued !== undefined` から `isOCells`／`dbcsType === "open"` へ緩める。新しい表し方は作らない
- 理由 / 代替案: J・E は詰め物が全角空白（U+3000）で、打った全角空白と区別できない。別の表し方が要るので別の work（台帳に残す）。SBCS の通常欄（`dbcsType` 無し）は詰め物が半角空白で、値の側の作り直しが大きい（未測定。台帳）

## D2: RA・TD で書かれた字にも生バイトを持たせる
- 背景: ホストが書いた空白と書かなかった桁の見分けは snapshot のセルの生バイト（0x40）に依る。RA（繰り返し）と TD（透過データ）は生バイトを渡していなかった（`wtd-applier.ts`）
- 決定: RA の埋め字（属性でも 0x00 でもないとき）と TD のバイトに生バイトを渡す。ACS の HostPlane は受信したバイトをそのまま持つので、空白（0x40）は中身になる
- 影響: カタカナ表示モードの読み替えが RA・TD の字にも効く（通常の字と同じ。`setChar` の注記どおり「ホスト発の SBCS にだけ渡す」）。実機の PUB400 のトレースには RA の 0x40 は出ていない（RA の 0x00 で入力欄を空にする形）ので、実機の実例は未確認

## D3: End は 0x40 も空きも飛ばす（鎖にも効く）
- 背景: End の空き判定は空白だけだった。詰め物が NUL の O 欄では End が末尾の空きの上に止まった
- 決定: O 欄の End は空白と空きを空きとして飛ばす（ACS `getEndPosition` は 0x40 と NUL をバイトで飛ばす）。継続した O 欄の鎖も同じ経路なので、鎖の End の潜在の不具合も直った

## D4: 入力欄の値の U+0000 は空白として見せる
- 背景: IME の合成開始で入力欄の値に手前の桁を入れる処理が、空きを U+0000 のまま入力欄へ出していた（`displayText`）
- 決定: `displayText` は U+0000 も空白にする（桁は 1 つ）

## D5: 過去の決定の破棄
- 破棄: `20260930-cont-o-nul` D1「空きと空白の区別は継続した O 欄の鎖だけに持たせる。継続でない O 欄・J・E は従来どおり」のうち継続でない O 欄
- 証拠: `scripts/verify-browser-space-typed.mjs`（f3・f4）は修正前に `c1`（ACS は `c1 40`）で不一致、修正後は READ MDT・ALT とも一致。回帰の実機スクリプト 9 本（o-field・je-field・cont-o・cont-o-paste・cont-o-lone-shift・either-remainder・either-empty-view・word-wrap・space-typed）が一致のまま

## D6: 既存のテストの期待の直し
- 「空きも空白」で書かれていた期待を、空き（U+0000）に直した: `screen-grid.test.ts`（手前の桁・貼り付け前の空き）・`o-field-cells.test.ts`・`o-chain-cells.test.ts`・`dbcs-pure-field.test.ts`・`delete-word.test.ts`（最後の語の削除は、語の前のホストの空白が末尾に残る。ホストが書いた空白は中身なので ACS は送る）・`packages/tn5250/test/o-field-cells.test.ts`（打った末尾の空白は送る）。fixture のホストが書いた空白には生バイト 0x40 を持たせた
