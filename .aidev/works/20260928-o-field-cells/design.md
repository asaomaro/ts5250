# 仕様: O 欄の編集をセルの並びで行う

## 概要
継続していない O 欄の編集の値に SO/SI の印を持たせ、打鍵・挿入・Delete・Backspace・Erase EOF・Field Exit を ACS の表どおりにセルの上で行う。コアは印を含む値をセルの構造どおりに置き、付け直さずに送る。

## 設計方針
- 印は生バイトのセンチネル 0x0E（`SO_MARK`）・0x0F（`SI_MARK`）。値に印があれば「明示の並び」として、web-ui の `dbcsByteLength`・`dbcsViewLayout`・`columnView` とコアの `writeValue` は暗黙の SO/SI を足さない（印の無い値は従来どおり——E・J・G 欄・全角の無い O 欄）
- コアの `setFieldValue` は印を含む値を構造どおりのセル（SO・全角の前半/後半・SI・空）に置く（`setFieldCells`）。送信は未編集の DBCS 欄と同じ道
- web-ui の純関数 `oFieldCells.ts`: `toCells`・`fromCells`・`overwrite`・`insert`・`del`・`backspace`・`eraseToEnd`。編集の値（要素＝印・全角 1 字・半角 1 字）とセルの桁を `cellOfEntry`・`entryOfCell` で行き来する
- ScreenGrid: `isOCells(f)`（O・継続でない）の欄は、値をセルから印入りで組み（`cellsValue`）、打鍵・挿入・Delete・Backspace・Erase EOF・Field Exit・Field+ を `oFieldCells` に回す。
  エラーは 0005・0012・0065 を操作員メッセージにし、「何もしない」は値もカーソルも変えない
- 当 PJ 独自の操作（選択の削除・語の削除・複数行の貼り付け・日付の選択）は ACS に無いので、終わったあと `normalizeO`（印を外して論理値から組み直す）で並びを正す
- カーソルは印の要素にも止まる（要素の添字＝キャレット）。Tab・Backtab の SO への着地はコアの `tabPosition`（O は SO に着く）と列ビューの対応で決まる

## 対象範囲
- `packages/web-ui/src/composables/fieldValidate.ts`・`oFieldCells.ts`（新規）・`opMessages.ts`・`components/ScreenGrid.vue`
- `packages/tn5250/src/protocol/read-response.ts`（`writeValue`）・`screen/buffer.ts`（`setFieldCells`）

## 依拠する既存の事実
- research F1〜F10
- Backspace の欄の先頭は 0005（`ScreenGrid.vue` の `onDbcsKeydown`。`backspace-dbcs-field-start.txt` の実測）
- Tab の着地は `packages/tn5250/src/screen/search.ts` の `tabPosition`（O 欄は SO の次に進めない）

## インターフェース / データ構造
- `OCell { k: "sb"|"so"|"si"|"lead"|"tail"; ch }`・`OResult = {cells, cursor} | {error} | {noop}`

## 振る舞いの詳細
- 空きは半角空白（ACS の NUL と同じに扱う）。末尾の空きはコアが空のセルにし、送るときに落ちる

## エラー処理 / 異常系
- 0005・0012・0065 は値もカーソルも変えず操作員メッセージを出す

## 受け入れ基準との対応
- AC1: `overwrite`・`insert`（単体。ACS の実測 16 通り）
- AC2: `del`・`backspace`・`eraseToEnd`（単体。ACS の実測 8 通り）
- AC3: `writeValue`・`setFieldCells`（単体）と実機（ブラウザで打鍵して、ホストが受け取ったバイト列を ACS と比べる）
- AC4: 列ビューのキャレットの対応（単体）と ScreenGrid のカーソル（コンポーネントの単体）
