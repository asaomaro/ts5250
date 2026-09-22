# タスク: 施錠中・応答待ち中の打鍵を捨てずに溜め、解錠で再生する（先打ち）

## 実装方針
原典と実機で溜め・破棄・その場処理を確かめ、分類を純関数にしてから、ペインに溜めと再生を置く。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 再生が新画面の欄フォーカスより先に走ると、打鍵が古い位置へ入る（setTimeout(0) で後ろへ回す）。
- アプリの操作（Ctrl+C・タブ切替）を溜めると、施錠中にアプリが操作できなくなる。

## テスト方針
- 分類の単体テストと、ペインをマウントして busy / keyboardLocked を切り替える結合テスト。
- 溜め・再生・停止・破棄の判定を 1 つずつ外して落ちることを確かめる。

## タスク
- [x] T1: 原典（`ECLPS.SendKeys` / `reset`・GUI の経路）と実機（ECL）で溜め・再生・破棄を確かめる。
      対象: `acshod2.jar` の `ECLPS` `beans/HOD/Screen` `Session`、`scripts/acs-probe/type-ahead.txt`
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: 分類の純関数。
      対象: `packages/web-ui/src/composables/useKeymap.ts` `typeAheadKind`
      依存: T1
      AC: AC1, AC3
- [x] T3: ペインの溜め・再生・破棄・機能キーボタン・Insert のその場処理。
      対象: `packages/web-ui/src/components/EmulatorPane.vue` `onKeydownCapture` `onFkeyAid` `resetKey`
      依存: T2
      AC: AC1, AC2, AC3
- [x] T4: テストと mutation、旧テストの注記の見直し。
      対象: `packages/web-ui/test/type-ahead.test.ts` `keyboard-locked-input.test.ts` `escape-during-busy.test.ts`
      依存: T3
      AC: AC4
- [x] T5: 節目の独立点検の指摘を直す（溜めをセッションごと・フォーカスを持つときだけ流す・1 キーごとに反映を待つ・
      溜めが残る間は生の打鍵も積む・予約と切断で捨てる・到達しない分岐の撤去・パレット）。
      対象: `EmulatorPane.vue` 先打ちの節、`stores/sessions.ts` `typeAhead` `applyLink` `setReserved`
      依存: T4
      AC: AC1, AC2, AC3, AC4
