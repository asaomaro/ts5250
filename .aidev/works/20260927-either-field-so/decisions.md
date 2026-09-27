# 決定記録

## D1: 状態は値に混ぜず、別の欄として送る

- 値（`edits`）は表示にも使うので、SO のセンチネルを混ぜると空の欄に化けた字が出る。ws の `fields[]` に `eitherDbcsOn` を足し、`edits` と同じ寿命の別の表（`SessionState.eitherDbcsOn`）で持ち回る。
- `20260927-either-field-rest` の decisions D1（取り下げ）が求めた「画面の側の状態を送る値に載せる作り」を、値ではなく隣の欄で実現した。

## D2: 状態を渡さない呼び出しは従来どおり値から推す

- MCP・HLLAPI・マクロは画面の側の状態を持たない。`opts` が無ければ `noteEitherMode` のまま（空の値では変えない）。ws は `eitherDbcsOn` が無いとき 2 引数で `setField` を呼ぶ（明示の `undefined` と省略は呼び出し記録で別物）。

## D3: Erase Input も状態を添える・J 欄は空にしても SO と SI を残す（独立点検の後の実測）

- 実機の ACS のコア（`scripts/acs-probe/either-erase-input.txt`）: Erase Input の後、全角の状態の E 欄は `0e`、J 欄は `0e`＋NUL＋`0f`、O・G の欄は何も送らない。
- E 欄: 画面の Erase Input の経路（`eraseInputKey`）も `eitherDbcsOn` を添えるようにした。
- J 欄: 空の値を書いたら先頭に SO・末尾に SI を置き、間は NUL にする（`buffer.ts` の `placeEmptyShift`）。打鍵で空にした J 欄も同じ扱いになる（ACS の打鍵の経路は測っていない——J 欄は SO/SI を欄の構造として持ち続けるので同じと見た。未確認）。
- 継続欄の中間・最終の区間には置かない（E・J の継続欄は未確認）。

## D4: `eitherSwitched` を欄ごとに持つ

- 以前は 1 つだけで、別の E 欄で切り替えると前の欄の状態が消えた。状態を送る値に添えるようになって、誤ったバイトを送る経路になった（独立点検）。`Map` にした。

## D5: 画面の他の経路（貼り付けの非フォーカスの欄・`commitFieldValueDirect`）は状態を添えない

- 値が空白だけでない限り、コアは値の先頭の字から正しく推せる。空の値になるのは Erase Input と打鍵の経路で、どちらも添えている。
