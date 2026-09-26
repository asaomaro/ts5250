# 仕様: O 欄の挿入の必要桁（SO/SI 込み）を ACS に合わせる

## 概要
挿入モードの非継続の O 欄で、ACS の必要桁（research F1）が当 PJ の数え方より大きくなる 2 つの場合に、末尾の空き（ACS の数え方）が必要桁に足りなければ 0012 にする。
入ったときの値（論理値）は変えない（decisions D2）。

## 設計方針
- `dbcsType`（`packages/web-ui/src/components/ScreenGrid.vue:2225`）の挿入の経路に、**ACS の必要桁の検査**を 1 つ足す。既存の「字を入れてから欄に収まるか」（`absorbDbcs`）はそのまま残し、
  その前に ACS の検査で落とす。既存の検査は当 PJ の正規化した並びの桁数で見るので、ACS より緩いことはあっても厳しいことは無い（research F5）——足すのは「より厳しい」側だけで足りる。
- 退けた案: 必要桁を ACS の表（8 通り）から常に引き直す——当 PJ で起きない SO・SI の桁の行（research F4）まで持ち込み、既存の一致している場合を書き換えることになる。差の出る 2 つに絞る。

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`（`dbcsType` と、判定の小関数 1 つ）
- `packages/web-ui/test/`（新しいテスト 1 ファイル。既存の DBCS 挿入のテストは変えない）
- `.aidev/backlog/acs-parity.md`（D2・D3 の別項目の起票と、本項目の消し込み。deliver で）

## 依拠する既存の事実
- O 欄のカーソルは字の桁か末尾（全角で終わる並びの後ろは SI の桁）にしか止まらない（`packages/web-ui/src/composables/fieldValidate.ts:212` `dbcsViewLayout`。research F4）。
- 挿入の 3 経路（打鍵・貼り付け・IME の確定）は `dbcsType` を通る（`ScreenGrid.vue:3234`・`:3746`・`:3852`。design 時に grep で確認）。
- 全角の判定は `isWideForDbcs`（`packages/web-ui/src/composables/fieldValidate.ts:153`。research A2）。
- カーソルが欄の最終桁なら即 0012 は既存の `atLastColumn`（`ScreenGrid.vue` の `dbcsType` の先頭）が持つ（`20260921-dbcs-insert-room`。research F2 の前半）。
- `replaced`（選択を置き換える挿入）は最終桁の判定を掛けない（`ScreenGrid.vue:2227` のコメント）。
- 欄の桁数は `visLen(f)`、論理値のバイト長（SO/SI 込みの桁数）は `byteLen(value, f)`（`ScreenGrid.vue:271`）。

## インターフェース / データ構造
- 新しい関数（`ScreenGrid.vue` 内・非公開）: `acsInsertShortOfRoom(e: EditState, ch: string, f: Field): boolean`
  ——挿入モードの非継続 O 欄で、ACS の必要桁が空きを超えるとき true。
- テストは既存の `packages/web-ui/test/dbcs-insert-room.test.ts` と同じく **ScreenGrid を mount して打鍵する**（関数は切り出さない）。新しいテストファイル `packages/web-ui/test/dbcs-insert-sosi-room.test.ts` に、
  SO・全角・SI のセルを持つ O 欄の画面を作る補助を置く。入力の桁（view の添字）は `A`=0・SO=1・`あ`=2・`い`=3・`う`=4・SI=5・`B`=6 で、C3 は `B`（6）、C4 は最初の全角（2）に当たる
  （論理位置ではそれぞれ 4・1。research F4 の `logToView`）。

## 振る舞いの詳細
- 対象: `e.insertMode && !replaced && f.dbcsType === "open" && f.continued === undefined`。
- 前の字 `prev = e.chars[e.cursor - 1]`、カーソルの字 `cur = e.chars[e.cursor]`、全角か `wide(x) = isWideForDbcs(x)`。
- 必要桁 `need`:
  - (i) 打つ字が全角、`cur` が半角の字（空白を含む）、`prev` が全角 → **4**（ACS: 半角の字の桁へ全角＝SO・字・SI）。
  - (ii) 打つ字が半角、`cur` が全角、`prev` が無いか半角 → **3**（ACS: 並びの最初の全角の桁へ半角＝SI・字・SO）。
  - それ以外 → 検査しない（当 PJ と ACS の桁数が一致。research F5）。
- 空き `room = visLen(f) − byteLen(末尾の半角空白を除いた論理値, f)`（ACS `reserveRoomForInsert`: 末尾から NUL・空白を数え、字・SO/SI で止まる。
  全角空白は並びの中にあり SI で止まるので数えない——測定 F1 と同じ。NUL の桁は当 PJ の論理値では値の外＝`visLen` と `byteLen` の差に含まれる）。
  カーソルが最終桁のときは既存の `atLastColumn` が先に 0012 にするので、ここでは見ない。
- `room < need` なら `dbcsType` は `undefined` を返す（呼び出し側が 0012 にし、値を変えない——既存の拒否と同じ経路）。

## ドメイン固有の考慮
- ACS の原典は事実の確認に使い、表現は写していない（研究 F1 は表を当 PJ の言葉で書き起こした）。
- 入ったあとの桁の使い方の差（D2）は残る。起票に書く。

## エラー処理 / 異常系
- 新しい例外経路は無い。拒否は既存の「`dbcsType` が undefined → 0012」を通る。

## 受け入れ基準との対応
- AC1: (i) が C3、(ii) が C4 に当たる。どちらも空き 2 桁で need（4・3）に足りず undefined → 0012・値は変わらない。入力はテストで背景の表の欄の中身・カーソル・字を作って与える。
- AC3: 検査は (i)(ii) の 2 つの場合だけ・O 欄・非継続・挿入モードに限るので、B2・B3・C1・C2・F1（どれも (i)(ii) に当たらない）は変わらない。既存テストと、同じ表の場合を新しいテストでも確かめる。
  並びの中の全角へ全角（need 2）・半角の中へ半角（need 1）も (i)(ii) に当たらず従来どおり。(ii) で空きが足りる C5（空き 4 ≥ 3）は入ることを新しいテストで確かめる（境界の確認）。
- AC4: research F7 に ACS の継続欄の手順を原典の根拠つきで記録し、差があるので decisions D3 で別項目に割る（AC4 の「割る」側。起票は deliver で `acs-parity.md` に、実機の ACS のコアでの測定から始める項目として）。
