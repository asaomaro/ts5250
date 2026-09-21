# タスク: 欄を出ないまま AID を押したら、送らずに操作員エラーにする（ACS の 0020）

## 実装方針
原典で条件を確かめ、実機で場合分けしてから、状態・判定・付け外しの順に積む。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 画面に CHECK(ME) 欄があると Enter が ME で止まり、0020 と取り違える（research F2 の無効だった 1 回目）。
- 付け外しの経路が多い。**経路ではなく結果（カーソル位置）で外す**。

## テスト方針
- ペインをマウントし、RZ・RB・符号付き数値・素・自動 Enter の欄で打って AID を押す。送信は `client.send` で見る。
- 付け外しの各経路を 1 つずつ外して落ちることを確かめる。

## タスク
- [x] T1: 原典で条件と除外 AID を確かめ、実機で 13 通りを測る。
      対象: `acshod2.jar` の `PS5250.processAIDCode` `Field5250`、`scripts/acs-probe/aid-without-field-exit.txt`
      依存: なし
      AC: AC1, AC2
- [x] T2: 状態・欄の種類・文言・`sendKey` の判定。
      対象: `sessions.ts` `mandatoryCheck.ts` `opMessages.ts` `session-controller.ts` `sendKey`
      依存: T1
      AC: AC1, AC3
- [x] T3: ペインの付け外し・通知の移し替え・フォーカス移動の除外。
      対象: `EmulatorPane.vue` `onEdit` `onFieldFull` `onLocal`
      依存: T2
      AC: AC1, AC2, AC3
- [x] T4: テストと mutation。
      対象: `packages/web-ui/test/aid-field-exit-required.test.ts`
      依存: T3
      AC: AC4
