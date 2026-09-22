# 仕様: ME・MF・自己点検を ACS と同じ時機・同じ条件で止める

## 概要
判定を 3 つの関数に分け（`mandatoryCheck.ts`）、`sendKey` の AID の前の検査を ACS の順に並べ、
ペインのカーソル監視に欄を出るときの検査を置く。CA キーはコアのスナップショットに載せる。

## 設計方針
- **順序は原典のまま**: MF（カーソル下）→ 0020 → 自己点検（カーソル下）→ ME（CA キーは見ない）。
- **ME は MDT**: 未送信の編集があるか、ホストが MDT を立てた欄は入力済み。画面の変更（どこかに MDT）が無ければ見ない。
- **欄を出るときは経路ではなくカーソル位置の変化で見る**（0020 の待ちと同じ）。新しい画面での移動は除く。
- **ステータスバーのボタンはペインのカーソルで送る**（ホストのカーソルだと、動かした後の位置で検査できない）。

## 対象範囲
- `packages/tn5250/src/screen/{types,buffer}.ts`（`caKeys`）
- `packages/web-ui/src/composables/mandatoryCheck.ts`・`opMessages.ts`
- `packages/web-ui/src/session-controller.ts`（`checkBeforeAid`）・`components/EmulatorPane.vue`・`components/StatusBar.vue`

## 依拠する既存の事実
- 原典の条件・順序: research F1。実機: research F2。
- CA キーのマスク: `ScreenBuffer.sendsDataForAid`（`packages/tn5250/src/screen/buffer.ts`）。
- 0020 の待ち: `SessionState.awaitingFieldExit`（`20260921-aid-without-field-exit`）。

## 受け入れ基準との対応
- AC1: `findMandatoryEnterViolation`・`checkBeforeAid` の CA キー判定。
- AC2: `findFieldViolation`（カーソル下の欄）と、ペインの `watch([cursor, snapshot])`。
- AC3: `isOperatorError` に 3 つの文言を足す・`StatusBar.press`。
- AC4: `ffw-behavior-bits.test.ts`・`self-check-field.test.ts`・`mandatory-check-acs.test.ts`・`aid-data-mask.test.ts` と mutation 9 通り。
