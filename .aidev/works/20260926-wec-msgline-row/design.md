# 仕様: 0x21 のメッセージを SOH のメッセージ行に重ねる

## 概要
core が 0x21 を受けたとき、`systemMessageArea` に {行＝メッセージ行（SOH の申告、既定 24）, 桁 1, 幅＝画面の桁数} を付ける。UI は既に位置があればそこへ重ねる（`20260926-window-error-code`）ので、UI の変更は無い。

## 設計方針
- 0x22 で入れた「重ねる位置」をそのまま使う（新しい仕組みを足さない）。位置の計算は core（research F1）。
- 1 行を超えた続きは合わせない（decisions D2）——幅を 1 行にするので、UI は行末で切る。
- 退けた案: 0x21 は UI 側でメッセージ行を知って置く——メッセージ行は core しか知らず、snapshot に別の項目を足すことになる。位置の形を 0x22 と揃えた方が UI の分岐が増えない。

## 対象範囲
- `packages/tn5250/src/protocol/wtd-applier.ts`（`applyWriteErrorCode` の 0x21 の位置）
- 型: `packages/tn5250/src/screen/types.ts` の `systemMessageArea` のコメント（0x22 だけ → 0x21 も）・`packages/tn5250/src/screen/buffer.ts` の同名フィールドのコメント
- テスト: `packages/tn5250/test/window-error-code.test.ts`（「0x21 には位置が付かない」を直し、行のテストを足す）・`packages/web-ui/test/window-error-code.test.ts`（0x21 の位置〔22 行・桁 1・幅 80〕を与えた描画のテストを 1 件足す）
- 台帳: `.aidev/backlog/acs-parity.md` の本項目に、D2 の差（1 行を超えた続きは合わせない）を消し込みと一緒に書く（deliver）
- 実機の検証資産: `scripts/host-src/dscmd.c` の WEC*・`scripts/acs-probe/wec-msgline-row.txt`・当 PJ の検証スクリプト（`scripts/verify-window-error-code.mjs` に 0x21 の場合を足す）

## 依拠する既存の事実
- ACS の 0x21 の行・範囲・長い本文: research F1〜F3（原典と実測）。
- 当 PJ の `systemMessageArea` と UI の重ね方: `20260926-window-error-code`（`ScreenGrid.vue` の `.opmsg-area`・`EmulatorPane.vue` の `messageArea`）。research A1。
- メッセージ行は `ScreenBuffer.messageLineRow`（`packages/tn5250/src/screen/buffer.ts`。SOH の申告、既定 24）。24×80 では ACS の既定（最下行）と一致する（research F2）。27×132 の画面では ACS の既定は最下行（27。`DS5250.processClearFMT`）——当 PJ も最下行へ戻すよう直した（decisions D5）。

## インターフェース / データ構造
- 変更なし（`ScreenSnapshot.systemMessageArea` を 0x21 でも付けるだけ）。型のコメントの「0x22 由来のときだけ」を直す。

## 振る舞いの詳細
- 0x21: `systemMessageArea = { row: messageLineRow, col: 1, width: cols }`。本文は従来どおり全部読む（上限なし）。
- UI: 位置の行・桁 1 から 1 行ぶんに重ねる。桁 1 は既存の字下げ（属性の桁＝ACS も属性を置く）で空き、本文は桁 2〜80 の **79 字まで**（ACS の 22 行と同じ。research F2・F3）。
  本文が 1 行より長ければ行末で切れる（`.opmsg-area` は `text-overflow: clip`）。
- 寿命・エラー状態: 変わらない（0x21 の既存の経路）。

## ドメイン固有の考慮
- 1 行を超えた本文で ACS が次の行を上書きする振る舞いは、情報を捨てるので合わせない（decisions D2）。

## エラー処理 / 異常系
- メッセージ行が画面の行数を超える申告は `setHeaderData` が採らない（既存）ので、行は常に画面の中。

## 受け入れ基準との対応
- AC1: 実機の 3 通り（申告なし・22 行・22 行で 90 字）で、当 PJ の snapshot の行・桁・幅を ACS（research F2・F3。22 行・23 行は触らない＝D2）と比べる——検証スクリプト。
  描画は `packages/web-ui/test/window-error-code.test.ts` に 0x21 の位置（22 行・桁 1・幅 80）を与えるテストを足して確かめる（0x22 の位置のテストと同じ経路）。範囲の外の行はセルを書かないので変わらない（core のテスト）。
  90 字の場合は 22 行の範囲だけを比べる（23 行は D2 で合わせない）。
- AC2: 既存の 0x21・0x22 のテスト（`write-error-code`・`system-message-lifetime`・`window-error-code`・`host-error-mode`）が通る。
- AC3: research F1〜F3、測定の手順（DSM の WEC*・`scripts/acs-probe/wec-msgline-row.txt`・検証スクリプト）をリポジトリに残す。
- AC4: 測定の後に `DSCMD` と IFS の `/tmp/dscmd.c`・`/tmp/dscmd.log` を消し、`test-result.md` に記録する（`scripts/build-dscmd.mjs:28-29` の既定の名前）。
