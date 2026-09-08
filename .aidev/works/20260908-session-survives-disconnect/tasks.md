# タスク: 転送断でセッションを失わない（猶予保持と再接続）

## 実装方針

サーバーから作る。**猶予保持が無いままクライアントの再接続を書いても、繋ぎ直す先が無い**ので
確かめようがない。サーバー側は「保持者トークン → 猶予 → `dispose` の分岐 → `resume`」の順で、
どれも 1 つずつ単体テストで閉じられる粒度にする。

クライアントは「半開き検出」と「再接続ループ」を分ける。前者は `ws-client` の層で完結し
（`session-controller` からは既存の `close` に見える）、後者は `session-controller` に閉じる。
表示（OIA）は状態を持つ store の変更を先に置いてから配線する。

**subtask には割らない。** サーバーとクライアントは同じ 1 つの振る舞い（繋ぎ直せること）を
両端から実装するもので、片方だけでは検証できない＝高結合。かつ 1 PR に収まる規模なので、
`aidev-docs/DESIGN.md`「5.」の決定木では「不可分」に当たる。

## 作業順序と依存関係

下の `依存:` に従う。それだけでは表せない理由は次の 2 つ。

- **T3（`dispose` の分岐）を先に確かめてから T4（`resume`）へ進む。** 猶予に入る条件を
  取り違えたまま復帰側を書くと、通ったテストが「猶予に入っていないセッションへの attach」を
  確かめただけになる。
- **T11（応急修正の見直し）は最後。** 再接続を足すと `onClose` の振る舞いが変わる
  （切断＝終わり、ではなくなる）ので、先に触ると 2 度直すことになる。

## リスク / 留意点

- **`dispose` は 5 種類の合流点**（5250 / 3270 / VT / プリンター / 監視）。分岐を足すときに
  既存の 3 判断をすり抜けさせない（design「対象範囲」・AC8）。
- **猶予タイマーは必ず `unref()` する。** 忘れるとプロセスが最大 60 秒終われなくなる
  （CI が遅くなるだけでなく、`--stdio` の MCP でも尾を引く）。
- **再接続で `SessionState` を作り直さない。** 差し替えるのは `client` だけ。作り直すと
  `edits`（打ちかけの入力）が消える（design「2. 復帰」）。
- **`WsClient.send` は OPEN でなければ黙って捨てる。** 再接続中の送信をそのまま通すと
  「押したのに何も起きない」になる。
- **再接続の対象は 5250 だけ。** 3270 / VT / プリンター / 監視はいずれも対象外で、
  サーバー（`dispose` の既存 3 判断）でもクライアント（`onClose` の各経路）でも
  **振る舞いを変えない**。AC8 はこの両側を指す。
- **数字の噛み合わせ**: 半開きの検出は 90 秒（T6）、再試行は累計 31 秒（T7）、猶予は 60 秒（T2）。
  半開きでは**サーバーもクライアントも「最後の往復」から 90 秒を数える**ので気づく時刻が
  ほぼ同時になり、31 秒の再試行は猶予 60 秒の内側に収まる。試行が先に届いた場合は
  まだ猶予に入る前で、セッションが生きているので成功する。
- **web-ui のテストはパッケージ dir から実行する**（`cd packages/web-ui && npx vitest run`）。
  ルートから実行すると偽陽性が出る（AGENTS.md）。

## テスト方針

- **サーバー**（`packages/server/test/`）: `SessionManager` は `now` 注入＋private の直叩きで
  既存テスト（`session-idle-timeout.test.ts`）と同じ手を使う。`ws-handler` は
  `ws-lifetime.test.ts` / `session-attach.test.ts` の組み立てに倣う。
  確かめるのは「転送断で閉じない」「期限で閉じる」「`close` メッセージでは猶予に入らない」
  「`resume` で猶予が解け責任が移る」「古いハンドラが復帰済みを閉じない」「既存判断が不変」。
- **クライアント**（`packages/web-ui/test/`）: `ws-client` は `ws-heartbeat.test.ts` の
  `FakeSocket` を使う。`session-controller` は `busy-loading.test.ts` の WsClient モックを使う。
  確かめるのは「`ping` 途絶で自分から閉じる」「最初の `ping` 前は見張らない」
  「再接続が `resume: true` を送る」「成功で `client` が差し替わり `edits` が残る」
  「`SESSION_NOT_FOUND` で打ち切り、手動ボタンを出さない」「試行が尽きたら手動ボタンが出る」。
- **実機**: 実際の瞬断からの復帰は単体テストでは確かめられない。**test 工程の「未検証の穴」**
  として明示する（design「未確定のまま design を出るもの」）。

## タスク

- [x] T1: `SessionManager` に保持者トークンを足す（`claim` / `isHolder`）。単調増加の番号を
      エントリに持たせ、後から `claim` した者を現在の保持者にする。
      対象: `packages/server/src/session-manager.ts:557-577`（フィールドと constructor）/
      `:1225-1272`（viewers の近傍に並べる） / 根拠: research A4
      依存: なし
      AC: AC8
- [x] T2: `SessionManager` に猶予の口を足す（`holdForReconnect` / `cancelHold` / `isHeld`、
      `SessionManagerOptions.reconnectGraceMs` 既定 60_000・0 で無効）。期限は `unref` した
      一度きりのタイマーで畳み、保険として `sweepIdle` でも期限切れを刈る。
      対象: `packages/server/src/session-manager.ts:1450-1467`（`sweepIdle`）/ `:557-577` /
      根拠: research A4・design「1. 転送断 → 猶予」
      依存: T1
      AC: AC1, AC6
- [x] T3: `ws-handler.dispose` に `transportLost` を足し、保持者照合を既存の 3 判断より前に置き、
      従来 `sessions.close` を呼んでいた一点を猶予へ回す。`onSocketClose` と心拍の死判定だけが
      `transportLost` を立てる（クライアントの `close` メッセージは立てない）。
      対象: `packages/server/src/ws-handler.ts:1052`（`dispose`）/ `:247`（`onSocketClose`）/
      `:439-453`（`startHeartbeat`）/ `:217-218`（`close` メッセージ）/ 根拠: research A1・A2・A6
      依存: T2
      AC: AC1, AC6, AC8
- [x] T4: `WsOpen.resume` を足し、`attach(sessionId, resume)` を実装する。`resume: true` は
      `attached` を立てず、`cancelHold` と `claim` を行う。所有者検査は既存の
      `sessions.get(id, user)` のまま通す。
      対象: `packages/server/src/ws-messages.ts:14-23`（`WsOpen`）/
      `packages/server/src/ws-handler.ts:882`（`attach`）/ `:471`（振り分け）/ 根拠: research A3・A5
      依存: T3
      AC: AC2, AC11
- [x] T5: サーバー側の回帰テストを書く（テスト方針のサーバー欄の 6 点）。
      対象: `packages/server/test/`（新規 2 本。`SessionManager` の分は
      `session-idle-timeout.test.ts` の手（`now` 注入＋private 直叩き）、`ws-handler` の分は
      `ws-lifetime.test.ts` / `session-attach.test.ts` の組み立てに倣う）
      依存: T4
      AC: AC1, AC2, AC6, AC8, AC9, AC11
- [x] T6: `WsClient` に半開きの見張りを足す。`ping` を受けるたびに張り直し、90 秒来なければ
      自分で `ws.close()` する。**最初の `ping` を受け取るまで張らない**（後方互換）。
      対象: `packages/web-ui/src/ws-client.ts:99-102`（`ping` の受信）/ `:51`（`connect`）/
      根拠: research A7・design「3. 半開き」
      依存: なし
      AC: AC7
- [x] T7: `session-controller` に再接続ループを足す。`onClose` から起動し、
      1s→2s→4s→8s→16s（±20% のゆらぎ）で最大 5 回、`open { sessionId, resume: true }` を送る。
      成功したら `SessionState.client` だけ差し替えて画面を反映し、`SESSION_NOT_FOUND` なら
      打ち切って理由を出す。あわせて **(a) 手動で再試行を再開する口**（T9 のボタンが呼ぶ）と、
      **(b) 再接続中の AID 送信を断り操作員メッセージを出す扱い**（`WsClient.send` に黙って
      捨てさせない。リスクの項）も、この経路の一部として実装する。
      対象: `packages/web-ui/src/session-controller.ts:155`（`openSession` のハンドラ）/
      `:738`（`closeSession`——利用者が閉じたときは再接続しない）/
      `:599`（`sendKey` の送信口） / 根拠: research A8
      依存: T4, T8, T12
      AC: AC2, AC3, AC5, AC10
- [x] T8: `SessionState` に `reconnect` / `reconnectFailed` を足す（design「I/F・データ構造」）。
      対象: `packages/web-ui/src/stores/sessions.ts:139-145`（`busy` / `loading` の近傍）
      依存: なし
      AC: AC5
- [x] T9: 表示を配線する。`StatusBar` の `inputState` が `reconnect` を見て「再接続中 (n/5)」を
      返し、`role="status"` を付ける。`reconnectFailed` のときだけ手動の繋ぎ直しボタンを出し、
      押したら再試行を再開する。フォーカスは奪わない。画面は覆わない。
      ボタンは T7 が公開する再開の口を呼ぶだけにする（再試行の制御は `session-controller` 側）。
      対象: `packages/web-ui/src/components/StatusBar.vue:45-59`（`inputState`）/ `:202`
      （`role="status"` の前例）/ `packages/web-ui/src/components/EmulatorPane.vue:1056`（StatusBar の配線）/
      根拠: research A9
      依存: T7, T8
      AC: AC5, AC10, AC-I1, AC-I2, AC-I3, AC-I4, AC-I5
- [x] T10: クライアント側の回帰テストを書く（テスト方針のクライアント欄の 6 点）。
      対象: `packages/web-ui/test/`（新規 2 本。`ws-heartbeat.test.ts` / `busy-loading.test.ts` に倣う）
      依存: T6, T9
      AC: AC3, AC5, AC7, AC9, AC10, AC-I2, AC-I3
- [x] T11: 既投入の応急修正（`onClose` まわり）を再接続ありの前提で見直す。切断が
      「終わり」ではなくなるので、操作員メッセージと `connected` の落とし方が再接続の開始と
      噛み合っているかを確かめ、必要なら調整する。VT / プリンターは再接続の対象外なので
      現状のままでよいことを確認する。
      対象: `packages/web-ui/src/session-controller.ts`（`onClose` の 3 経路）/
      `packages/web-ui/src/composables/opMessages.ts`（`MSG_CONNECTION_LOST`）/ 根拠: research F14
      依存: T10
      AC: AC4, AC8
- [x] T12: 5250 の受信処理（`opened` 以外のメッセージ分岐）を、新規 open と再接続で共用できる
      関数へ切り出す。**振る舞いは変えない**（純粋な切り出し。既存テストが緑のままであることが完了条件）。
      対象: `packages/web-ui/src/session-controller.ts:155-290`（`openSession` の `onServerMessage`）/
      根拠: research A8
      依存: なし
      AC: なし
