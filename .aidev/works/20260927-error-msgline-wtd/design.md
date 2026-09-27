# 仕様: エラー状態のままメッセージ行へ WTD・RESTORE が来たとき（調査）

## 概要
実装はしない（decisions D1）。測定の資産を残し、差と設計の材料を backlog に起票する。

## 設計方針
research の事実をもとに、保留の実装を別の work にする。

## 対象範囲
- 測定の資産: `scripts/host-src/dscmd.c`（ERRMSGWTD / ERRMSGRST。`QsnSavScr`・`QsnRstScr`）・`scripts/acs-probe/error-msgline-wtd.txt`・`scripts/verify-error-msgline-wtd.mjs`・`scripts/README.md`
- 台帳: 消し込みと起票

## 依拠する既存の事実
- 当 PJ はメッセージ行への書き込みで `systemMessage` を消す（`packages/tn5250/src/screen/buffer.ts` の `clearSystemMessageIfTouched`）
- エラー状態は web-ui の `hostErrorDismissedSeq`（`packages/web-ui/src/components/EmulatorPane.vue`）

## インターフェース / データ構造
- 変更なし

## 振る舞いの詳細
- 変更なし

## エラー処理 / 異常系
- 該当なし

## 受け入れ基準との対応
- AC1: research F1・F3
- AC2: research F2・backlog の起票
- AC3: DLTPGM と IFS の削除
