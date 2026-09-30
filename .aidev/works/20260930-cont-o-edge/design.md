# 仕様: 継続した O 欄の貼り付けと単独の SO/SI の Delete

## 概要
鎖の操作の結果に `warn`（操作は行ったがエラーも出す）を足し、単独の SO/SI の Delete は詰め直しの結果を返す。貼り付けは 1 字ずつの鎖の打鍵として流し、最初の区間を出たところで止める。

## 設計方針
ACS の手順の事実（F1〜F4）だけを、既存の鎖の操作（`reflow`・`chainInsert`・`chainOverwrite`）の上に載せる。貼り付けの区間またぎは新しい規則を作らず、打鍵と同じ関数を回す。

## 対象範囲
- `packages/web-ui/src/composables/oChainCells.ts`・`packages/web-ui/src/components/ScreenGrid.vue`
- テスト・実機検証スクリプト・台帳

## 依拠する既存の事実
- `reflow(segs, pos, ops)` は操作列が空でも死んだ桁を捨てて詰め直す（`oChainCells.ts` の `reflow` の 1 の `dead` を飛ばす。Delete が既に `reflow(out, pos, [])` を呼んでいる）
- `chainOverwrite` は区間の終わりで足りないとき、次の区間の頭で打ち直す（同 `chainOverwrite`。P7 の打鍵が ACS と一致している）
- 打鍵の反映は `oChainApply`（`ScreenGrid.vue`）。ほかの区間の値は `commitDbcsSegment` で直接出す

## インターフェース / データ構造
- `ChainResult` に `{ segs, cursor, warn?: 0x65 }`
- `chainPaste(segs, pos, chars, insert)` → `{ segs, cursor(=pos), placed, error? }`
- ScreenGrid: `oChainCommit`（反映の共通部）・`pasteIntoChain`

## 振る舞いの詳細
- Delete: 単独の SO/SI（k = 0）は詰めずに `reflow(segs, pos, [])`。結果に `warn: 0x65`。呼び出し側は反映したうえで 0065 のメッセージを出す
- Backspace: 区間の頭で前の区間の最後の桁が単独の SO/SI のときも同じ（`chainDelete` の結果をそのまま返す）。SO/SI の次の Backspace は `backspaceTarget` の 0065 で止まる（詰め直さない）
- 貼り付け: 字ごとに `chainInsert`／`chainOverwrite`。カーソルの区間が最初の区間と変わった字を置いたら止める。エラー（0005・0012・0065）ならそこまでを残す。カーソルは貼る前の位置へ戻す。1 字でも置けたら MDT

## エラー処理 / 異常系
- 途中でエラー: それまでの字は残り、理由を操作員メッセージにする

## 受け入れ基準との対応
- AC1: `o-chain-paste.test.ts`・実機 `verify-browser-cont-o-paste.mjs`（P1〜P8 のうち P3 を比べる）
- AC2: `o-chain-edit.test.ts`（同じ字の貼り付け）
- AC3: `o-chain-cells.test.ts`（D1〜D8）・実機 `verify-browser-cont-o-lone-shift.mjs`
- AC4: 同上（D3・D4）
