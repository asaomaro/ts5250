# レビュー: SCS の重ね打ち・罫線・半分の幅

## ラウンド 1（独立の読み）
- 原典の照合: DGL の検査の順（長さ→種類→選択→位置）・縦線の溜めと `canClear`・字幅の写像を `processDefineGridLines`・`JPSState` と 1 行ずつ突き合わせた。ACS が位置の配列を範囲外まで読む場合（横線の位置が 2 つ未満）は、写さず無視にした（原典の未定義動作）
- 共有層: `LogicalPage` は `decor` を**無いときは持たない**ので、既存の帳票・履歴・JSON は形が変わらない（実採取 2 件で確認）。`shifts` を組み直す箇所は `ReportText.vue` だけで、`decor` は行の添字が同じ
- 規約: ACS のコード・コメントは写していない（手順は自分の言葉。字幅の表は事実）。`node:*` の import なし（scs は純ロジック）。PDF は罫線・字を pt でそのまま置く
- 描く側の共通化: 字の見せ方（`overGlyphView`）・線の見た目（`ruleLook`）を `report-line.ts` に置き、配布 HTML と画面が同じ関数を通る

指摘:
- [nit][conv:-] 半分の幅・重ね打ちで下になった字は検索・コピーに出ない / 対応: 意図した限界（decisions D3）
- [nit][conv:-] 実機のホストがこれらを出すかは未確認 / 対応: 台帳と test-result に明記
