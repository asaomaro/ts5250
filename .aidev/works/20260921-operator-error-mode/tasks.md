# タスク: 操作員エラーでキーボードを施錠し、Reset キーで解く

## 実装方針
原典で抜ける経路を洗い、キーごとの振る舞いは実機で測ってから、ペインの capture に振り分けを置く。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- **エラー状態の作り損ね**: 1 回目の実機測定は前提が崩れて無効だった（F4）。前が `inhibit=5` かを必ず見る。
- 通知の直接代入が残ると、その経路だけ施錠されない。

## テスト方針
- ペインをマウントし、英字専用欄への数字で型違反を起こしてから各キーを打つ。
- 拒否・挿入解除・Reset の取り消し・クリックを 1 つずつ外して落ちることを確かめる。

## タスク
- [x] T1: 原典で入口と抜ける経路を確かめ、キーごとの振る舞いを実機で測る。
      対象: `acshod2.jar` の `PS5250`、`scripts/acs-probe/error-mode-exit-keys.txt` `error-mode-other-keys.txt`
      依存: なし
      AC: AC1, AC2
- [x] T2: `isOperatorError` と、通知の入口を `showNotice` に寄せる。
      対象: `packages/web-ui/src/composables/opMessages.ts` `packages/web-ui/src/components/EmulatorPane.vue`
      依存: T1
      AC: AC2
- [x] T3: 打鍵の振り分け・Reset・クリック。
      対象: `packages/web-ui/src/components/EmulatorPane.vue` `onKeydownCapture`
      依存: T2
      AC: AC1, AC2, AC3
- [x] T5: 挿入モードが解ける時点を実機で測り直し（dump に `insert=`）、実装を「入ると解ける／Reset は常に解く」に直す（D3）。
      対象: `scripts/acs-probe/AcsProbe.java` `dump`、`scripts/acs-probe/error-mode-insert-timing*.txt`、`EmulatorPane.vue` `showNotice` `resetKey`
      依存: T3
      AC: AC2, AC3
- [x] T4: テストと mutation。
      対象: `packages/web-ui/test/operator-error-mode.test.ts`
      依存: T3, T5
      AC: AC4
- [x] T6: 節目の独立点検の指摘を直す（挿入モードを編集中の状態へ写す・ホイールを AID の入口へ・タブ切替で持ち越さない・古い決定の注記）。
      対象: `ScreenGrid.vue` `watch(insertMode)`、`EmulatorPane.vue` `onWheel` と `sessionId` の監視、`opMessages.ts` 冒頭
      依存: T4
      AC: AC2, AC3
