# 調査: 表示セッションの開始の知らせ（起動応答のコード）

## 調査の問い
- Q1: ACS は起動応答のコードを画面のどこに・いつ・どれだけ出すか。
- Q2: 当 PJ は起動応答のコードをどこまで持っていて、どこで画面へ渡せるか。

## 判明した事実
- F1（原典）: ACS の状態行 `HODStatusBar.commEvent` は通信状態 37 で `KEY_I901`（仮想装置の機能が元の装置より少ない）を出し、続けて ACS のときは
  `AcsOnly.displayResponseCode` を呼ぶ。後者は応答コードが I901・I902 なら `KEY_SESSION_START_SUCCESS`（英語は「%1 - Session successfully started」）を
  3,000 ms 出し、それ以外は `KEY_RESPONSE_CODE`（「Response code: %1」。%1 はコードの文言、無ければコード）を 3,000 ms 出す。通信状態が変わるたびに呼ばれる。
- F2（原典）: `StatusBar.displayText(文言, ms)` は時間が来ると `clearText()` で消す（前の文言に戻さない。3270 の接続済み表示を除く）。
  したがって I901 の個別の文言はすぐ開始の文言に上書きされ、3 秒後に状態行は空になる。
- F3（原典）: `DS5250.processDiagnosticInformation` は I901 で通信状態 37 を立てて成功（0）を返し、I902 と同じく開始の処理に進む。
- F4（当 PJ）: 起動応答は `Session5250.startup`（`packages/tn5250/src/session/session.ts:663`）。繋ぎ直しで空にして取り直し、`reconnected` イベントに載せて出す（同 :1025・:1046）。
- F5（当 PJ）: 表示セッションの `opened`（開く `packages/server/src/ws-handler.ts:588`・後から入る :1088）と `host-reconnected`（:1010）は起動応答のコードを載せない。
  プリンターは載せている（:913 の `startupCode`）。
- F6（当 PJ）: web-ui は `SessionState.startupCode`（`packages/web-ui/src/stores/sessions.ts:291`）をプリンターだけが使い、ⓘ（`SessionInfo.vue:122`）もプリンターだけに出す。
  ペインの通知は `state.notice`（`EmulatorPane.vue` の `effectiveNotice`）で、情報の通知はエラー状態に入らない（`showNotice` の `isOperatorError`）。
- F7（実測。`20260921-associated-printer`）: 存在しない装置名を関連付けると I901、関連付けなし・正しい装置なら I902（社内機）。

## 実装アンカー
- A1: `packages/server/src/ws-messages.ts` `WsOpened` / `WsHostReconnected`
- A2: `packages/server/src/ws-handler.ts` の `opened`（開く・後から入る）と `onReconnected`
- A3: `packages/web-ui/src/session-controller.ts` の `opened`（:732）・後から入る（:470〜）・`host-reconnected`（:616）
- A4: `packages/web-ui/src/composables/opMessages.ts`（文言）・`SessionInfo.vue`（ⓘ）

## 実装時の注意
- 3 秒で消すのは「そのとき出した文言がまだ出ていれば」。間に別の通知（エラー等）が出たら消さない。
- 実機の I901 は `associatedPrinter` に存在しない名前で起こせる（`20260921-associated-printer`）。

## design への申し送り
- ACS が実際に見せるのは開始の文言（I901 の個別の文言は即座に上書きされる）。I901 だけ特別な文言にはしない。
