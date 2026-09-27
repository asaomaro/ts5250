# レビュー: READ の欄データの加工

## タスク点検ログ
- [should][conv:comment-provenance!] T1 `read-response.ts` 0x83 の JSDoc「`buildReadMdtResponse` に AID 0 を渡したものと同値」が誤りになった / 対応: 取り消し線で残し、欄データは ALT で加工しないと書き直した
- [should][conv:comment-provenance!] T1 `signedNumericValue` の JSDoc が旧規則のまま / 対応: 0x52 はもう通らない（DBCS の退避路だけ）と注記
- [nit][conv:-] T1 mdt の `nul[i] ? " " : c` は等価変異 / 対応: 意図をコメントに書いた
- [nit][conv:-] T1 長さ 1 の符号付き数値の欄で ACS は配列外参照 / 対応: コメントに書いた
- [should][conv:measurement-sanity!] T2 手前が空白・英字のときの 0xD0・0xD1 は原典だけ / 対応: READALT に 2 欄足して実機の ACS のコアで測り、`40404040d1`・`40404040d0` を確かめた（当 PJ も一致）
- [nit][conv:measurement-sanity] T2 ACS の実測が 1 回ずつ / 対応: 2 回目の測定（6 欄）で最初の 4 欄も同じ値だった。原典とも一致（research F2）
- [nit][conv:verify-by-mutation] T2 DBCS の退避路を消す変異が落ちない / 対応: 確かめた——落ちない。違いが出るのは未編集の DBCS 欄の途中に NUL があるときだけで、そこは退避路も ACS と違う（対象外として台帳に残す）ので、ACS と違う出力をテストで固定しない
- [nit][conv:-] T2 プログラム名の不揃い / 対応: probe を既定の `DSCMD` に揃えた
- [should][conv:-] cross `flatValue`（0x42/0x72）の符号の畳み方は「手前が数字なら」のまま（ACS の平坦形式の枝も数字を見ない）/ 対応: 対象外。台帳に起こした
- [nit][conv:-] cross `runPcCommand` は READ の種類を見ずに 0x52 の形で返す / 対応: 以前からの差。台帳に起こした
- [nit][conv:-] cross G の欄は ALT でも 0x40 で埋める / 対応: 台帳の残りに並べた

## ラウンド 1
- 上の点検と同じ指摘（REVIEW 節）。must なし。should 4 件はすべて上で対応済み
