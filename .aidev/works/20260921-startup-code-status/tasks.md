# タスク: 表示セッションの開始の知らせ

## 実装方針
server で起動応答のコードを載せ、web-ui で受けて一時的に出す。

## 作業順序と依存関係
- 下の `依存:` に従う。

## リスク / 留意点
- 後から入ったタブ・繋ぎ直しで、他の通知を消さない。

## テスト方針
- 関係するテストだけ（server の ws・web-ui の session-controller・SessionInfo）。全量は節目で。

## タスク
- [x] T1: `opened`（開く・後から入る）と `host-reconnected` に 5250 の表示セッションの起動応答のコードを載せる
      対象: `packages/server/src/ws-messages.ts` `WsOpened` `WsHostReconnected` / `packages/server/src/ws-handler.ts` / 根拠: research A1, A2
      依存: なし
      AC: AC1
- [x] T2: web-ui で受けて開始の文言を 3 秒出し、ⓘ にコードを出す
      対象: `packages/web-ui/src/composables/opMessages.ts` / `packages/web-ui/src/session-controller.ts` / `packages/web-ui/src/components/SessionInfo.vue` / 根拠: research A3, A4
      依存: T1
      AC: AC2, AC3
- [x] T3: 実機で I902・I901 が届くことを確かめる（消化は test 工程）
      対象: scratch の測定スクリプト
      依存: T1
      AC: AC4
- [x] T4: 条件を外す mutation（消化は test 工程）
      対象: T1・T2 のテスト
      依存: T1, T2
      AC: AC5
