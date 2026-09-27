# レビュー: WEA の否定応答

## タスク点検ログ
- [should][conv:-] T1 `wtd-applier.ts` WEA の頭のコメント（効果は実装しない・2 バイト消費して進める）が事実と違う / 対応: 取り消し線で直し、長さを正しく読む理由だけ残した
- [nit][conv:-] T1 `SENSE.ATTRIBUTE_TYPE` の doc と EA の実装（`EA_LENGTH`）の不一致 / 対応: EA のタイプの誤りも `ATTRIBUTE_TYPE` にした（値は同じ）
- [nit][conv:-] T1 SF の属性が最後の桁のとき ACS の位置が画面の外になりうる（欄が画面の外に出るので FFT で弾かれる見込み）/ 対応: 指摘のみ（実害なし）
- [should][conv:-] T2 `wtd-applier.test.ts` の JSDoc が「後続オーダーを失わない」のまま / 対応: 取り消し線で直した
- [nit][conv:verify-by-mutation] T2 変異の記録が無い / 対応: 3 通りを実際に当てて記録（test-result.md）
- [nit][conv:measurement-sanity] T2 ACS の実測は 1 回ずつ / 対応: 原典・対照と一致する旨を research に書いた
- [should][conv:measurement-sanity!] cross AC2・AC3 の実機の結果が work に無い / 対応: test-result.md に記録（pass=16・両方の実機の片付け）
- [nit][conv:-] cross 台帳の該当行 / 対応: deliver で閉じる

## ラウンド 1
- 上と同じ指摘（REVIEW 節）。must なし。should 3 件はすべて対応済み
