# タスク: ME・MF・自己点検を ACS と同じ時機・同じ条件で止める

## 実装方針
原典と実機で条件を確かめ、コアに CA キーを出し、判定・送信前の順序・欄を出るときの検査の順に積む。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 旧テストは「Enter のときだけ・内容で判定」を固定している。方針に合わせて書き換える（D1 の破棄）。
- 欄を出るときの検査が新しい画面の到着で誤発火しないこと。

## テスト方針
- 判定の単体テスト、ペインを通した結合テスト（欄を出る・エラー状態・ボタンのカーソル）、mutation。

## タスク
- [x] T1: 原典で順序と条件を読み、実機で 9 通りを測る。
      対象: `PS5250.processAIDCode` `FFT5250.checkMandatoryFieldCheck` `Field5250`、`scripts/acs-probe/mandatory-me-mf.txt`
      依存: なし
      AC: AC1, AC2
- [x] T2: コアのスナップショットに CA キーを載せる。
      対象: `packages/tn5250/src/screen/buffer.ts` `snapshot`、`types.ts` `ScreenSnapshot.caKeys`
      依存: T1
      AC: AC1
- [x] T3: 判定関数と送信前の検査の順序。
      対象: `mandatoryCheck.ts`、`session-controller.ts` `checkBeforeAid`
      依存: T2
      AC: AC1, AC2
- [x] T4: 欄を出るときの検査・エラー状態・ボタンのカーソル。
      対象: `EmulatorPane.vue` `watch([cursor, snapshot])`、`opMessages.ts` `isOperatorError`、`StatusBar.vue` `press`
      依存: T3
      AC: AC2, AC3
- [x] T5: テストの書き換え・追加と mutation、旧決定 D1 の破棄の記録。
      対象: `ffw-behavior-bits.test.ts` `self-check-field.test.ts` `mandatory-check-acs.test.ts` `aid-data-mask.test.ts`
      依存: T4
      AC: AC4
