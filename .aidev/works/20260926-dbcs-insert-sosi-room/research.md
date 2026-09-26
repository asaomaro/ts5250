# 調査: O 欄の挿入の必要桁（SO/SI 込み）と継続欄の数え方

## 調査の問い
- Q1: ACS は O 欄の挿入で、何桁の空きを要求するか（打つ字 × カーソルの桁の種類）。
- Q2: ACS は空きをどう数えるか（`reserveRoomForInsert`）。
- Q3: 当 PJ の O 欄のカーソル（論理位置）は、ACS のカーソルの桁のどれに当たるか。
- Q4: 当 PJ は ACS の挿入の結果（SO/SI の置き方）を表せるか。
- Q5: 継続欄（O）の ACS の手順。

## 判明した事実
- F1（Q1。原典 `PS5250.insertChar`、ACS 同梱 `acshod2.jar` を CFR で読んだ。DBCS セッションで J/G/Unicode 以外の欄）: {前進, 必要桁, 操作列} の表を引く。
  - 全角を打つ: カーソルの桁が 半角の字 → 必要 **4**（SO・全角・SI）／SO → 2／SI → 2（全角を SI の位置に置き、SI は右へ）／全角の字 → 2。
  - 半角を打つ: 半角の字 → 1／SO → 1（SO の前に置く）／SI → 1（SI・字）／全角の字 → **3**（SI・字・SO。並びを割る）。
  - 全角の並びの**最初の全角の桁**へ半角を打つと、操作列は「SI・字・SO」をカーソルの桁（SO の直後）に置くので、**空の SO・SI が残る**（`A`・SO・SI・`X`・SO・`あい`…）。
- F2（Q2。原典 `reserveRoomForInsert`・非継続）: カーソルが欄の最終桁なら即 false。欄の末尾からカーソルの 1 つ手前まで、NUL・半角空白・全角空白の桁を数え、
  それ以外（SO/SI を含む）に当たったら止める。数えた空きが必要桁未満なら false（→ 0012）。足りれば必要桁ぶん右へずらす。継続欄は `reserveRoomForContField` へ分岐する。
- F3（実測。`scripts/acs-probe/dbcs-insert-room.txt` の記録、`20260921-dbcs-insert-room` research F2）: C3・C4（空き 2 桁）は 0012、C1（4 桁ちょうど）・C5 は入る。F1・F2 の読みと一致する。
- F4（Q3。`packages/web-ui/src/composables/fieldValidate.ts:212` `dbcsViewLayout`）: 当 PJ の O 欄の値は論理的な字の並びで、SO/SI は全角と半角の境目から導く（`view` に SO/SI の印を足す）。
  カーソル（論理位置 i）は `logToView[i]`＝**その字の桁**に置かれ、SO の桁・SI の桁には止まらない。例外は末尾——全角で終わる並びの後ろのカーソル（`endCaret`）は **SI の桁**に当たる。
  よって ACS の表のうち当 PJ で起きるのは「半角の字の桁」「全角の字の桁」「末尾の SI の桁」の 3 種。
- F5（Q3 の帰結）: 当 PJ の現在の数え方（`ScreenGrid.vue:2225` `dbcsType` → `absorbDbcs`。字を挿入してから `byteLen` で欄に収まるかを見る）と ACS の必要桁が食い違うのは次の 2 つだけ:
  - (i) 全角の並びの**直後の半角の字**の桁へ全角を打つ（C3）: ACS は別の並び（4 桁）、当 PJ は前の並びに繋げる（2 桁）。
  - (ii) 全角の並びの**最初の全角**の桁へ半角を打つ（C4）: ACS は SI・字・SO（3 桁）、当 PJ は字 1 桁（SO が後ろへずれるだけ）。
  それ以外（並びの中の全角へ全角＝2、並びの中ほどの全角へ半角＝SI・字・SO で 3、半角の中の半角＝1、末尾の SI の桁＝全角 2・半角 1、並びから離れた半角の字の桁へ全角＝4）は当 PJ も同じ桁数になる。
- F6（Q4。`packages/tn5250/src/screen/buffer.ts:1155` `fieldValue`・`:1216` `dbcsRawFieldValue`）: 未編集の DBCS 欄はホストの生バイト（SO/SI の空や不整合も）をセンチネルで持ち回すが、
  **編集した欄は論理値になり、送信時に codec が SO/SI を付け直す**（空の SO/SI・隣り合う SI SO は表せない）。web-ui の DBCS 欄の編集（`dbcsType`・Backspace・Delete・Erase EOF・貼り付け・IME）もすべて論理値の上で動く。
  ACS の (i)(ii) の**結果のバイト列**（別の並び・空の SO/SI）を当 PJ で作るには、DBCS 欄の編集の値の表し方そのものを変える必要がある。
- F7（Q5。原典 `processCharWithDBCSOpenContField`・`mergeDBCSString`・`checkWordsFitDBCSOpenContField`）: 継続の O 欄では、カーソルから鎖の最後までのホストのバイト列を作り直して操作列を差し込み、
  **隣り合う SI・SO を取り除いて並びを繋げ直し**（`mergeDBCSString`）、鎖の後続の区間へ**語単位で詰め直して**収まるかを見る（収まらなければ false）。
  当 PJ は区間の中で数える（`20260921-insert-no-room` D3）。数え方が根本から違い、SI SO の併合で (i) のような差も出ない。実機では未測定。

## 影響範囲
- `packages/web-ui/src/components/ScreenGrid.vue` の `dbcsType`（挿入モード・O 欄）。呼び出し 3 か所（打鍵・貼り付け・IME の確定）は同じ関数を通る。

## 実現性 / リスク
- 必要桁の判定（受け入れの可否）は、論理値のまま F5 の 2 つの場合を足せば ACS と揃う。
- 結果のバイト列を揃える（F6）は、DBCS 欄の編集モデルの変更（core の送信・web-ui の全編集操作）になり、この項目の規模（優先度 低・深さ △）を大きく超える。

## 実装アンカー
- A1: `dbcsType`（`packages/web-ui/src/components/ScreenGrid.vue:2225`）——挿入モードの判定を足す場所。
- A2: `dbcsViewLayout`（`packages/web-ui/src/composables/fieldValidate.ts:212`）・`isWideForDbcs`（同 :153）——並びの境目の判定に使う。
- A3: 既存テスト——`dbcsType` の挿入を見ているテストを `packages/web-ui/test/` で grep（`dbcs-insert` 等）。

## 実装時の注意
- 判定は **O 欄（`dbcsType === "open"`）かつ非継続（`continued` 無し）**に限る。J・E・G は別の規則で済んでいる（`20260921-dbcs-insert-room`・`g-field-sosi`）。
- 「空き」の数え方は ACS の F2 に合わせる——論理値では「末尾の半角空白・全角空白」だが、SO/SI の桁で止まるので、全角で終わる値の末尾の全角空白は数えない（F1 の測定 F1 と同じ。既存の `absorbDbcs` の `wideBlank` は O 欄で false）。
- 選択を置き換える挿入（`replaced`）は、既存どおり最終桁の判定を掛けない扱いと揃える。

## design への申し送り
- (a) は「受け入れの可否」だけを ACS に合わせ、結果のバイト列の差（F6）は別項目に割る（decisions D2）。
- (c) は F7 の事実を記録して別項目に割る（decisions D3）。
