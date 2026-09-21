# タスク: ホストに切られたら、ACS と同じく自動で繋ぎ直す

## 実装方針
コア → サーバー → ブラウザの順に積み、コアとサーバー経由の両方を実機で確かめる。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 接続処理を分解するので、既存の接続・拒否・時間切れのテストが緑のままであること。
- 無限に試す作りなので、自分から切ったら必ず止まること・拒否で止まること。

## テスト方針
- コア: 偽の transport を順に配って、即座・間隔・諦め・自分からの切断を見る。サーバー・ブラウザ: 配線。mutation。実機 2 経路。

## タスク
- [x] T1: ACS 製品が既定を上書きするかを原典で確かめる（残っていた未確認）。
      対象: `acshod2.jar` の `com/ibm/eNetwork/HOD/acs`
      依存: なし
      AC: AC3
- [x] T2: コアの自動再接続。
      対象: `packages/tn5250/src/session/session.ts`
      依存: T1
      AC: AC1, AC3
- [x] T3: サーバーの有効化・通知・ジョブ情報。
      対象: `ws-handler.ts` `onOpen` `subscribeSession`、`ws-messages.ts`、`session-manager.ts` `open`
      依存: T2
      AC: AC2
- [x] T4: ブラウザの状態・通知・送信と先打ちの扱い。
      対象: `session-controller.ts` `applyDisplayMessage` `sendKey`、`stores/sessions.ts`、`opMessages.ts`、`EmulatorPane.vue`
      依存: T3
      AC: AC2
- [x] T5: テスト・mutation・実機（コア単体とサーバー経由）。
      対象: `auto-reconnect.test.ts` `ws-host-reconnect.test.ts` `host-reconnect.test.ts`、`scripts/verify-*auto-reconnect.mjs`
      依存: T4
      AC: AC4
- [x] T6: 節目の独立点検の指摘を直す（`opened` に繋ぎ直しの状態・接続の世代・交渉中の状態・安全な通知・画面の作り直しの時機・
      照会の照合・予約中は繋ぎ直さない・`closed` の購読の解除・寿命の表をホスト側からの切断で測る）。
      対象: `session.ts`、`ws-handler.ts`、`ws-messages.ts`、`session-manager.ts`、`session-controller.ts`、`session-lifetime-matrix*`
      依存: T5
      AC: AC1, AC2, AC3, AC4
