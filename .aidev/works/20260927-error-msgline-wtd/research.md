# 調査: エラー状態のままメッセージ行へ WTD・RESTORE が来たとき

## 調査の問い
- Q1: ACS のコアの見え方（Reset の前後）
- Q2: 仕組み（原典）
- Q3: 当 PJ の見え方

## 判明した事実
- F1（Q1・実測。2026-09-27・社内機。`scripts/acs-probe/error-msgline-wtd.txt`・DSM の ERRMSGWTD / ERRMSGRST）:
  - WTD: エラーの間は 24 行目に `ERROR ON MSGLINE` のまま（inhibit=5）。**Reset の後** 24 行目は ` NEW LINE24IGINAL TEXT TO BE RESTORED`（元の行に WTD が重なった形）。
  - RESTORE（1 回目）: エラーの間は `ERROR ON MSGLINE` のまま、Reset の後は ` MSGLINE ORIGINAL…`——ただしこの形は退避した 24 行と 0x21 の直前の 24 行が同じで、「保留された」と「即時に書かれ Reset の戻しで上書きされた」を区別できなかった（review の指摘）。
  - RESTORE（2 回目・区別できる形。退避の後・0x21 の前に 24 行を `CHANGED` に替える）: エラーの間は `ERROR ON MSGLINE`、**Reset の後は ` CHANGED ORIGINAL TEXT TO BE RESTORED`**（0x21 の時点の行）——
    RESTORE は保留されず即時に処理され、Reset の戻し（0x21 の時点の行）が RESTORE の 24 行を上書きした。
- F2（Q2・原典）: ACS は WRITE ERROR CODE でメッセージ行を退避し（`saveMsgLinePosition`）、`restoreMsgLinePosition`（0x21 の時点の行を戻す）で戻す。
  **保留するのは WTD だけ**: `DS5250.checkContention` は WTD コマンドの頭（WRITE ERROR CODE の中の WTD でないとき）と `processWriteToDisplay` の入口・オーダーごとのループの頭で呼ばれ、
  `ps.getMsgLinePos() != -1` の間データ処理のスレッドを `wait()` で止める——**止まった WTD より後のレコード（READ など）も結果として後ろに並ぶ**。RESTORE（`processRestoreScreen`）・CLEAR UNIT・SAVE・READ・WSF・WEC は保留の確認を持たない（CLEAR UNIT・SAVE はエラー状態を解く）。
  `MsgLinePos` が立つのは WEC と SysReq（`processSysreq` → `saveMsgLinePosition`）。解くのは `restoreMsgLinePosition` → `clearContention`（`clearErrorMode`・`clearSysreqMode`・エラーヘルプの終わり）。
  `clearErrorMode` の契機: エラー中のキー（BS などの編集系を除くほぼ全部。`PS5250.keyDown`）・カーソル・Reset 系のキー・`processReset`・Help の AID（`processAIDCode`）・メッセージ行のクリック・CLEAR UNIT・SAVE SCREEN。
  ⚠ デコンパイルの字面では 0x22 の WTD の部分も `MsgLinePos` が立った後に `processWriteToDisplay` を通る（自分を保留しかねない）——CFR の復元の誤りの可能性。`20260926-window-error-code` の実測と突き合わせて確かめること。
- F3（Q3・実測。`scripts/verify-error-msgline-wtd.mjs`）: 当 PJ は保留しない。
  - WTD: 受けた時点でメッセージ行へ書き、`systemMessage` を消す（`clearSystemMessageIfTouched`）——エラーのメッセージが Reset を待たずに消え、24 行目は ` NEW LINE24IGINAL…`。**画面の側のエラー状態も Reset を待たずに終わる**（ACS は inhibit=5 のまま）。Reset の後の中身は ACS と同じ。
  - RESTORE（2 回目の形）: `systemMessage` は残り（重ねたまま）、24 行目のセルは ` CHANGED ORIGINAL…`——Reset で重ねを外すと ACS と同じ見え方。

## 影響範囲
- 保留を入れるなら: core（`Session5250` の受信の保留）・server（Reset の中継）・web-ui（Reset で保留を解く）。エラー状態は今は web-ui の側（`hostErrorDismissedSeq`）にだけある

## 実現性 / リスク
- 保留は「Reset しない限りホストの出力が止まる」振る舞いで、画面の側のエラー状態と core の受信を結ぶ必要がある

## 実装アンカー
- 該当なし（調査のみ）

## design への申し送り
- 起票: エラー状態の間のホストの出力の保留（ACS `checkContention`）
