# レビュー記録

## ラウンド 1

- [should][conv:-] `packages/tn5250/src/protocol/wtd-applier.ts` 番地 -1 の SF の属性を捨てている——ACS は `row1col0*` で 1 行 1 桁から効かせる / 対応: `ScreenBuffer.row1col0Attr` を足し、スナップショットの最初の属性にした（CLEAR UNIT で捨てる）
- [should][conv:-] `wtd-applier.ts` 番地 -1 に SF 以外が来ると従来どおり例外で失う / 対応: ACS の振る舞いは未確認として注記と decisions D6 に記録
- [should][conv:-] `wtd-applier.ts` `checkNewField` の後ろの欄の枝が無く、ACS が黙って受ける SF に 0x10050125 を返す / 対応: `ScreenBuffer.checkNewField` で写した（decisions D8）
- [should][conv:-] `wtd-applier.ts` 長さ 1 の O 欄を断っている（ACS は符号付き数値・J・E・G だけ） / 対応: 直した
- [should][conv:-] `wtd-applier.ts` 継続欄の nn が 01/02/03 以外・ワードラップの組・再順序付け・カーソル送りの規則が抜けている / 対応: 前の 2 つを足し、残りは decisions D7 に記録
- [nit][conv:-] FFW の無い SF も ACS は `addFieldToFFT` を通す / 対応: decisions D7
- [nit][conv:-] 自己点検の 33 桁の上限は DBCS の欄に掛からない / 対応: 直した
- [nit][conv:-] `buffer.ts` の JSDoc が `addField` から離れている / 対応: 直した
- [nit][conv:-] `addField` の同じ位置の置き換え・`keepEither` が到達しない / 対応: 取り除き注記した
- [nit][conv:verify-by-mutation] 同じ位置の SF のテストが長さ・FFW を見ていない / 対応: 長さ・FFW・MDT・種類を見るようにした
