# 調査: O 欄の編集（ACS のセルの規則）

原典の読みの全文（自分の言葉で書いた表）は作業中の scratchpad に置いた（ACS の頒布物に由来するのでリポジトリには入れない）。ここには設計に要る事実だけを書く。

## 判明した事実
- F1（原典 `ECLPS`・`PS5250`）: セルの種類は SO（0x0E）・SI（0x0F）・全角の前半・後半・半角（空と空白を含む）。
  「並びの中」＝その桁から欄の終わりへ向かって SO より先に SI に会う。カーソルは SO・SI に止まれ、全角の後半には止まらない
- F2（上書き `inputChar`）: 全角はカーソルと後ろ数桁の種類で決まる表（例: 半角 4 桁 → SO 字 SI、SO の上 → 並びの頭に足す、SI の上で後ろが半角 2 桁 → 字 SI で並びを延ばす、
  欄の終わりに届けば 0005、どれにも当たらなければ黙って何もしない）。半角は SO の上なら空の組・並びの頭の字を潰す、SI の上なら SI の後ろに置く（進み 2）、
  並びの中の全角の上なら SI 字（空白）…（最後のセルの SI の上は 0065）
- F3（挿入 `insertChar`・`reserveRoomForInsert`）: 全角は半角の上で SO 字 SI（4 桁）、SO・SI・並びの中の上で 2 桁。半角は半角・SO の上で 1 桁、SI の上で SI の後ろ（1 桁・進み 2）、
  並びの中で SI 字 SO（3 桁）。空きは欄の終わりから NUL・空白・全角空白（SO/SI を除く）を数える。カーソルが最終桁なら 0012
- F4（`processDeleteChar`・`processBackspace`）: SO+SI・SI+SO の組は 2 桁で消し、単独の SO・SI は 0065、全角 2 桁、半角 1 桁。後ろは NUL で埋める。
  Backspace は直前が全角なら 2 桁、直前と今が SO/SI の組ならその組、直前が単独の SO/SI なら 0065、欄の先頭は 0005（当 PJ も `backspace-dbcs-field-start.txt` で実測済み）
- F5（`eraseToEOF`）: カーソルから欄の終わりを NUL にし、カーソルが SI の上か並びの中なら、カーソルの桁に SI を置く。Field Exit・Field+ も同じ消去（O 欄は右寄せしない）。Field− は 0016
- F6（カーソル）: Tab・Backtab・自動送りは O 欄では SO に着く（J・E は SO の次）。Home・Erase Input は SO の次
- F7（送信 `sendAll`）: セルのバイトをそのまま送る（空の SO/SI も）。READ MDT は末尾の NUL を落とし途中の NUL を 0x40
- F8（当 PJ）: 編集は `ScreenGrid.vue` の `dbcsType`・`dbcsBackspace`・`dbcsDelete`・`eraseToEndDbcs` が論理値の配列で行い、送るときにコアの `writeValue` が SO/SI を付け直す（`read-response.ts`）
- F9（この work で足した土台）: 値に SO/SI の印（0x0E・0x0F のセンチネル）があれば、web-ui の `dbcsByteLength`・`dbcsViewLayout`・`columnView` とコアの `writeValue` は暗黙の SO/SI を足さず、
  コアの `setFieldValue` はセルを構造どおりに置く（`o-field-cells.test.ts`・`o-field-explicit.test.ts`）

## 実装アンカー
- A1: `packages/web-ui/src/composables/oFieldCells.ts`（新規。純関数）
- A2: `packages/web-ui/src/components/ScreenGrid.vue` の `logicalValue`・`logicalFromCells`・`baselineValue`・`dbcsType`・`dbcsBackspace`・`dbcsDelete`・`dbcsDeleteWord`・`eraseToEndDbcs`・`dbcsMove`・`deleteSelection`・貼り付け
- A3: `scripts/host-src/dscmd.c` の OEDIT・`scripts/acs-probe/`（ACS のコアの測定）

## 実装時の注意
- 継続した O 欄は今の作りのまま（印を持たせない）
- 「黙って何もしない」の場合は値もカーソルも変えず、エラーも出さない

## 実測（2026-09-28・社内機・ACS のコア。`scripts/acs-probe/o-field-edit.txt`・DSM の OEDIT）
- F10: 上書き 8・挿入 8・削除系 8 の計 24 通りで、原典の読みから立てた予測のバイト列とホストが受け取ったバイト列がすべて一致した
  （例: (i) `あB` の B に挿入 い → `0e44810f0e44820fc2`、(ii) `あい` の あ に挿入 X → `0e0fe70e448144820f`、`あ` を Delete → `0e0f`、`あいう` の い から Erase EOF → `0e44810f`）。
  エラーの 5 件（11 桁目の全角・満杯の挿入・単独の SO/SI の Delete・単独の SI の直後の Backspace）は inhibit=5 で値が変わらない
