# 仕様: HLLAPI の Tab・Backtab・Home で欄を出るときの MF・自己点検

## 概要
HLLAPI の `moveCursor` で Tab・Backtab・Home の行き先を決めたあと、ACS `moveCursorWithMandFillCheck` と同じ検査を掛ける。
違反なら出る欄の先頭へカーソルを置き、SendKey は `rc=5`（FUNCTION_INHIBITED）で残りのキーを処理せずに返る。

## 設計方針
- 検査はサーバーの新しいモジュール `packages/server/src/hllapi-leave-check.ts` に置く（使うのは HLLAPI だけ。AGENTS「片方しか使わないものは使う側に置く」）。
  web-ui の `mandatoryCheck.ts` は未送信の編集（edits）を前提にし、サーバーから import できない。HLLAPI の書き込みは core に即時に入るので、スナップショットだけで判定できる。
- 判定の意味は web-ui の `mandatoryFillViolated` / `selfCheckViolated` にそろえる（同じ画面でペインと HLLAPI の結果が食い違わないように）:
  MF は MDT（継続欄は並びのどこか）があり、値が空白以外を含み、最終桁が空白（満杯でない）。自己点検は空白以外があり検算が合わない。非表示欄は値が読めないので見ない。
  ACS はヌルだけを空とみなすが、HLLAPI の書き込み（`writeIntoField`）は欄を空白で埋めるのでヌルでは判定できない（web-ui と同じ近似）。
- ACS の操作員エラー（inhibit=5・後ろの字を受けない）に当たる状態を HLLAPI は持たないので、「以降のキーを処理しない＋`rc=5`」で表す（文字を入力禁止の欄へ打ったときと同じ返し方）。

## 対象範囲
- `packages/server/src/hllapi-leave-check.ts`（新規）
- `packages/server/src/hllapi.ts` の `moveCursor`・`sendKey`

## 依拠する既存の事実
- ACS `PS5250.processTab` / `processBacktab` / `processHome`（ホーム位置でないとき）は `moveCursorWithMandFillCheck(元, 行き先, true)` を呼ぶ。出る欄と行き先の欄が違うときだけ `checkMandatoryFillField` → 違反でエラー 20・欄頭、`checkModulusField` → 違反でエラー 21・欄頭（原典。scratchpad の `PS5250.java` の `moveCursorWithMandFillCheck`）
- 実機の ACS のコア: Tab・欄の外へ出る Backtab・Home で 7,20・`inhibit=5`、Tab の後ろの `CD` は入らない。欄の途中からの Backtab は止まらない（`scripts/acs-probe/hllapi-tab-mandatory.txt`。2 回）
- 自己点検の Tab で検査数字エラー（`scripts/acs-probe/selfcheck-field-exit.txt`）
- HLLAPI の書き込みは欄全体を空白で埋めて `setField` する（`packages/server/src/hllapi.ts` の `writeIntoField` の `padEnd`）
- `selfCheckDigitOk` は `@ts5250/tn5250` の root から出ている（`packages/tn5250/src/index.ts:24`）
- core の継続欄の MDT は先頭区間だけに立つ（`packages/tn5250/src/screen/buffer.ts` の `setFieldValue`）——並びで見る必要がある

## インターフェース / データ構造
- `leaveViolation(snapshot: ScreenSnapshot, from: number, to: number): Field | undefined` — `from`・`to` は 1 起点の PS 位置。違反した（出る）欄を返す
- `moveCursor(...)` は `boolean` を返す（false = 止まった）。`sendKey` は false で `{ rc: HRC.FUNCTION_INHIBITED }` を返す

## 振る舞いの詳細
- 出る欄 = `fieldAt(from)`。無い・保護欄なら検査しない。`fieldAt(to)` と同じ欄（index が同じ）なら検査しない
- 継続欄の区間ごとに別の欄として比べる（ACS も区間ごとの `Field5250`）。MDT は並びで見る
- 符号付き数値の欄は ACS と同じく最終桁（符号の桁）を満杯・空の判定から外す

## エラー処理 / 異常系
- 行き先が決まらない（Backtab で入力欄が無い）ときは動かないので検査しない

## 受け入れ基準との対応
- AC1: `moveCursor` の tab・backtab・home で `leaveViolation` → 欄頭・`rc=5`・ループを抜ける。実機は `scripts/verify-hllapi-tab-mandatory.mjs`（ADJPGM）で ACS の実測と比べる
- AC2: `leaveViolation` の自己点検・MF の各条件を単体で
- AC3: 行き先が同じ欄なら undefined（単体・実機の Backtab）
