# 調査: 起動応答 I901・I902 以外のコードの扱い

## 調査の問い
- Q1: ACS は I906・表に無いコードを受けたとき何をするか（原典）
- Q2: I906 を実機で出させられるか
- Q3: 当 PJ はいま何をしているか

## 判明した事実
- F1（Q1・原典 `DS5250.processDiagnosticInformation`）: 起動応答の先頭 4 バイトが I902 / I901 なら 0（I901 は通信状態 37 も立てる）。それ以外は 4 バイトそれぞれの下位 4 ビットを十進に並べた数を返す（I906 → 9906。`I`＝0xC9 の下位が 9）。
- F2（Q1・原典 `DS5250.processStartUpConfirmation`）: 診断情報つき（ヘッダの印 0x90。実機の起動応答はこれ。印 0x80 なら診断を読まずに 0 扱い）の結果が 0 のときだけ装置名を `SetWorkstationID`（セッションの `SESSION_WORKSTATION_ID` を書き換え、ACS では窓の題名も更新——`ECLSession.SetWorkstationID`→`SessionManager.refreshWindowTitle`。NEW-ENVIRON の DEVNAME を送るときにもこの値が読まれる——`NVT5250.insertVariable`→`AcsOnly.getUserSpecifiedWorkstationID`）、通信状態 7（`ECLConnection.SetCommStatus` で `workstationIDReady` が立つ）・5、OIA の準備完了、`isStartedUp`・`isSessionConnected`。
  2702〜8940 の各コードは個別の通信状態（エラー）へ。**9906（I906）や表に無い数はどの分岐にも入らず、何もしない**。
- F3（Q1・原典 `DS5250.processPassthru` / `tokenizeData`）: 起動応答の処理はレコードのヘッダの印（0x80 / 0x90）で呼ばれ、同じレコードのオペコードによる画面の処理は**起動応答の結果に関わらず続く**。
  印の無い後続のレコードでは、まだ `isSessionConnected` でなければ `setReadyConnect`（状態 6・5・準備完了）。→ I906 でもサインオン画面は描かれ、操作は続く。装置名だけが採られない（設定の装置名のまま）。
- F4（Q1・原典 `DS5250`）: `isStartedUp` を読む箇所は無い（代入だけ）。I906 の経路では後続のレコードの `setReadyConnect`（状態 6）を通るので、`IsWorkstationIDReady()` は false のまま（HACL から見える差）。
- F7（Q1・原典 `processDiagnosticInformation`）: ACS は応答コードの**各バイトの下位 4 ビットを十進に並べた数**で分岐する。当 PJ は**文字列**で判定する（`isKnownStartupCode`）。
  よって「表に無いコード」の集合は同じではない——下位 4 ビットが拒否の表の数（8901 等）に当たる未知の文字列を、ACS は拒否の分岐に入れるが、当 PJ は装置名があれば開く。そうしたコードが実在するかは未確認（RFC 4777・ACS の文言表にある既知のコードは当 PJ の表と一致）。
- F5（Q2・実測。2026-09-27・社内機）: 社内機の QRMTSIGN は `*FRCSIGNON`、PUB400 は `*VERIFY`（`QSYS2.SYSTEM_VALUE_INFO`）。
  社内機へ自動サインオン（平文）を要求すると、**ACS のコア（`scripts/acs-probe/startup-i906.txt`・`PROBE_BYPASS_SIGNON=clear`）も当 PJ（`Session5250.connect` の user/password）も I902** が返り、サインオン画面が続いた（ACS は wsidReady=true・装置名を採った）。
  → *FRCSIGNON では I906 ではなく I902＋サインオン画面。**I906 はどちらの実機でも出させられない**（システム値は共有の実機なので変えない）。I906 の実機での挙動は**未確認**のまま。
- F6（Q3・`packages/tn5250/src/session/session.ts` の 1 レコード目の分岐）: 既知のコードか装置名の入ったレコードなら `startupInfo` に採り、`STARTUP_SUCCESS_CODES`（I901・I902・I906）に無い既知のコードは `SESSION_REJECTED`。I906・装置名の入った未知のコードは `startupInfo` を採って続ける。
  I906 の経路を固定する core の単体テストは無い（`packages/*/test` を `I906` で検索。web-ui の文言のテストだけ）。

## 影響範囲
- `startupInfo.device` は ⓘ の装置名などに出る（当 PJ が知っている、ホストが割り当てた装置名）。

## 実現性 / リスク
- 振る舞いを変える必要は無い（F3: ACS も続ける）。差は装置名を採るかだけ。

## 実装アンカー
- A1: 1 レコード目の起動応答の分岐（`packages/tn5250/src/session/session.ts` の `startup && (isKnownStartupCode(...) || startup.device !== "")`）
- A2: 起動応答を返す試験（`packages/tn5250/test/` の起動応答まわり。未特定——coding で探す）

## design への申し送り
- 装置名を採らない ACS の扱いは、ホストが知らせた装置名を捨てることになる（AGENTS.md「ACS が情報を捨てているなら合わせない」の候補）。
