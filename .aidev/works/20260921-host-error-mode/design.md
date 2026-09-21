# 仕様: ホストのエラー（WRITE ERROR CODE）でも、ACS と同じくエラー状態に入る

## 概要
コアが WEC ごとに通し番号（`ScreenSnapshot.systemMessageSeq`）を振り、ブラウザは番号の変化でエラー状態に入る。
抜けたら、その番号のメッセージを隠す（メッセージ行を元に戻す）。

## 設計方針
- **文言ではなく番号で見分ける**: 同じ文言のエラーが 2 回目に来ても入り直すため。番号はプロセスで通し（画面バッファを
  作り直す繋ぎ直しでも重ならない）。
- **規則は操作員エラー（①）と同じ**: 振り分け（拒否・抜ける）は既存の `onKeydownCapture` がそのまま効く。
- **メッセージ行を元に戻す＝隠す**: 当 PJ は本文をセルへ書かず `systemMessage` として重ねているので、隠せば下の行が見える。

## 対象範囲
- `packages/tn5250/src/screen/{buffer,types}.ts`・`protocol/wtd-applier.ts`（`applyWriteErrorCode`）
- `packages/web-ui/src/components/EmulatorPane.vue`（番号の監視・`exitErrorMode`・`messageLine`）

## 依拠する既存の事実
- 原典と実機: research F1・F2。当 PJ の現状: F3（`verify-host-error.mjs`）。
- 操作員エラーの状態と振り分け: `20260921-operator-error-mode`（`errorMode` / `onKeydownCapture`）。

## 受け入れ基準との対応
- AC1: コアの `nextSystemMessageSeq`・ブラウザの `watch(systemMessageSeq)`。
- AC2: `exitErrorMode` の `dismissedHostErrorSeq`・`hostMessage`。
- AC3: `system-message-lifetime.test.ts`（コア 3 件）・`host-error-mode.test.ts`（5 件）と mutation。
