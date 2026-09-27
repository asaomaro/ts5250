# レビュー記録

## ラウンド 1

- [should][conv:measurement-sanity] `packages/tn5250/src/protocol/read-response.ts` NUL だけの G 欄は構造が無く、従来どおり 0x40 で詰める——原則どおりなら ACS は 0 バイト / 対応: READDBCS に NUL だけの G・O を足して実機で測り（ACS は 0 バイト）、`dbcsRawCells` を NUL だけの欄にも効かせた（decisions D4）
- [should][conv:verify-by-mutation] `packages/tn5250/test/read-dbcs-fields.test.ts` 継続欄の連結の後の末尾だけを見ることを固定していない / 対応: O の継続欄のテストを足し、区間ごとに落とす変異が落ちることを確かめた
- [nit][conv:-] `packages/tn5250/src/protocol/read-response.ts` `trimmedSendValue` へ来る経路の説明が不正確 / 対応: 直した
- [nit][conv:-] `scripts/host-src/dscmd.c` READDBCS の注記が直す前の挙動を現在形で書いている / 対応: 「直す前の当 PJ は」に直した
- [nit][conv:-] 生の G の枝の `substituted` は偶数への丸めで落とすバイトも数える / 対応: 対応しない（生の経路は置き換えがほぼ起きない）
