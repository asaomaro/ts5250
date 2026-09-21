# 仕様: 表示セッションの開始を起動応答のコードつきで知らせる

## 概要
server が 5250 の表示セッションの起動応答のコードを `opened` と `host-reconnected` に載せ、web-ui が「<コード> - セッションを開始しました」の意味の文言を
3 秒だけ通知に出す（ACS `AcsOnly.displayResponseCode` と同じ時機・長さ。research F1・F2）。ⓘ にもコードを出す。

## 設計方針
- 文言は ACS の意味を借りて当 PJ で書く（`opMessages.ts` の `startupStartedText(code)`）。I901 も同じ文言（ACS も実際に見えるのは開始の文言。research F2）。
- 3 秒のあと、**そのとき出した文言がまだ出ていれば**消す（ACS の状態行は時間で消えるが、当 PJ の通知欄はエラーと共用なので、後から出た通知を消さない）。
- 退けた案: I901 だけ「仮想装置の機能が少ない」を残す——ACS の画面では上書きされて見えない（research F2）。

## 対象範囲
- `packages/server/src/ws-messages.ts` / `ws-handler.ts`
- `packages/web-ui/src/composables/opMessages.ts` / `session-controller.ts` / `components/SessionInfo.vue`

## 依拠する既存の事実
- 起動応答の保持と繋ぎ直し: `packages/tn5250/src/session/session.ts:663`・`:1025`・`:1046`（research F4）
- `opened` と `host-reconnected` の送り先: `packages/server/src/ws-handler.ts:588`・`:1088`・`:1010`（research F5）
- web-ui の受け口と通知: `packages/web-ui/src/session-controller.ts:732`・`:470`〜・`:616`、`EmulatorPane.vue` の `effectiveNotice`（research F6）

## インターフェース / データ構造
- `WsOpened.startupCode?: string`（5250 の表示だけ。プリンターの `printer-opened` とは別）/ `WsHostReconnected.startupCode?: string`
- web-ui `startupStartedText(code: string): string`、`STARTUP_NOTICE_MS = 3000`

## 振る舞いの詳細
- 開いたとき（自分で開く・後から入る）と繋ぎ直したとき、`startupCode` があれば `state.startupCode` に入れ、通知が空なら（または繋ぎ直し中の通知なら）開始の文言を出して 3 秒後に消す。
  後から入ったタブで他の通知（留守中の PC コマンド等）があればそちらを優先する。
- ⓘ は表示セッションでも「起動」の行を出す（コードが無ければ出さない）。

## エラー処理 / 異常系
- 起動応答が無い（3270・VT・テスト用の注入）なら何も出さない。

## 受け入れ基準との対応
- AC1: ws-handler のテスト（開く・後から入る・繋ぎ直しで `startupCode` が載る。3270 には載らない）。
- AC2: session-controller のテスト（開始の文言が出て 3 秒で消える・間に別の通知が出たら消さない・エラー状態に入らない）。
- AC3: SessionInfo のテスト（表示セッションで「起動」の行）。
- AC4: 実機（社内機）で `Session5250` の `startup.code` が I902・I901 になり、server 経由の `opened` に載ることを確かめる。
- AC5: 条件を外す mutation。
