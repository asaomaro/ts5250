# 仕様: WDSF のマイナー構造体の否定応答

## 概要
`wdsfShapeSense`（0x50/0x51/0x60 の case）から、マイナー構造体を歩く専用の関数（`selectionMinorSense`・`windowMinorSense`・`gridMinorSense`）を呼ぶ。
主構造の長さ検査を通った後だけ呼ばれ、マイナーを自分の長さぶんずつ歩きながら、型ごとの長さ・位置の条件を確かめる。

## 設計方針
- 3 つの関数は独立させる（選択欄・窓・罫線でマイナーの形も検査の中身も違うため、共通化すると分岐だらけになる）
- 罫線のマイナーは、色・予約バイトを「読むが検査しない」ことを明示するコメントを残す（バイト位置がずれて見えるため）
- 反復・間隔つきの矩形が画面外へ出る総延長（型ごとに式が違う複雑な計算）は実装しない。マイナーの構造そのもの
  （長さ・型・行/桁/横罫/縦罫の単体の範囲・反復/間隔の下限）だけを検査する

## 対象範囲
- `packages/tn5250/src/protocol/wtd-applier.ts`

## 依拠する既存の事実
- `sf`（`[class, type, ...body]`）と `at(i)=sf[i-2]` の変換は既存の `wdsfShapeSense` のまま（research F6）
- `SENSE` オブジェクトへ 2 つ（`WDSF_GRID_MINOR_TYPE`=0x10050150、`WDSF_GRID_REPEAT_SPACING`=0x10050152）を足す。既存の `WDSF_MINOR`（0x10050113）・
  `WDSF_GRID_POSITION`（0x10050151）は流用する

## インターフェース / データ構造
- `selectionMinorSense(sf: Uint8Array): number | undefined`
- `windowMinorSense(sf: Uint8Array): number | undefined`
- `gridMinorSense(sf: Uint8Array, buf: ScreenBuffer): number | undefined`（罫線は画面のサイズが要る）

## 振る舞いの詳細
- 選択欄: スクロール・バー付き（flag2 の 0x80）かどうかでマイナーの開始位置が変わる（sf 添字 26／18）。メニューバーの区切りは
  `selectionType`（offset 7）が 1 のときだけ検査する
- 窓: マイナーは offset 9（sf 添字 7）から
- 罫線: マイナー自身の長さが 7〜11 の外か残りを超えれば即座に否定応答。型が 8 以上も即座に。行・桁・横罫・縦罫・反復・間隔は
  型ごとに検査の要否が変わる（research F4）
- どの歩く関数も、壊れた長さ（2 未満）に出会ったら無限ループを避けてループを抜ける（センスを返さない——それ以上先は読めないため）

## エラー処理 / 異常系
- マイナーの実バイト数が宣言より短くてもクラッシュしない（`sf[p+n]` は範囲外なら `undefined`。比較は `undefined < 1` 等になり
  意図しない真偽になりうるが、その前段の長さ検査で大半は弾かれる——`gridMinorSense` の `p + minorLen > sf.length` がこれを塞ぐ。
  選択欄・窓は長さの上限検査（属性 19・枠 13 等）は持つが実バイト数との突き合わせはしない——ACS も同様に長さの宣言だけを見て
  次のマイナーへ進むため、実装を合わせた

## 受け入れ基準との対応
- AC1: `packages/tn5250/test/wtd-order-sense.test.ts` に単体テストを追加（デコンパイル済みの原典の閾値を境界値で確かめる。26 通り）
