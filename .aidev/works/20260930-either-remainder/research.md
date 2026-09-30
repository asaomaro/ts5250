# 調査: E 欄の残りの ACS の挙動

## 調査の問い
- Q1: 伏せ字の E に全角・半角を打つと ACS は何を送るか
- Q2: E の欄の Dup は何バイト置くか
- Q3: E への挿入の余地は何で決まるか

## 判明した事実
- F1（実機。DSM の `EITHERX`・`scripts/acs-probe/either-remainder.txt` の X1）: 空の伏せ字の E に `あ` を打つと `0e 4481 00×8 0f`（ふつうの E と同じ full の形）。続けて `A` はエラー（入力として DBCS が必要）。空の伏せ字の E に `AB` を打つと `c1 c2`、続けて `あ` はエラー（フィールド・データは英数字でなければ…）。
- F2（X2）: Dup 可の E `SO あい SI`＋空き 6 の い の桁で Dup すると `0e 4481 1c×8 0f`（い 2＋空き 6 ＝ 8 バイト）。空の E の先頭で Dup すると `1c×12`（SO・SI なし）。
- F3（`either-insert.txt` の i1〜i6）: `SO あいうえ SI`＋空き 2 に全角 1 字は余地なし（0012）。同じ欄に半角は「入力として DBCS が必要」、満杯の E の SI の桁に半角も同じ。SBCS の E への全角は余地があっても断る（英数字でないと）。空の E への全角は入る。
- F4（原典 `PS5250.insertChar`）: J と全角の状態の E は余地の終点を欄の最後の桁の 1 つ手前にする（`--n3`）。SI が中身の直後（compact）の E は、空きを数えるとき SI で止まるので、SI の後ろの空き 2 のうち最後の桁を除いた 1 だけが余地。
- F5（当 PJ の差）: 伏せ字は `isDbcsEdit` を外していたので SBCS の経路に落ち、IME も止めていた。Dup は字の数で埋めていた（全角 1 字が 1 バイトの Dup になり 1 足りない）。挿入は欄長までを余地に数えていた。

## 実装アンカー
- A1: `packages/web-ui/src/components/ScreenGrid.vue`（`isDbcsEdit`・`syncDbcs`・`onCompositionStart`・`dupKey`・`dbcsType`・`insertInto`）
- A2: `packages/web-ui/src/composables/fieldEdit.ts`（`dupFill`）

## 実装時の注意
- 伏せ字は値をブラウザへ出さない設計（`Field.value` は空）。編集は空から始まり、表示は桁ぶんの空白
