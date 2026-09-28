# 仕様: J・全角の E の欄の送るバイト列を ACS と同じにする

## 概要
画面の側が J・全角の E の欄の「形」（full / compact / open。research F2）を欄ごとに決め、AID を送るときだけ、その形どおりの印入りの値（SO・字・NUL の組・SI）を送る。
画面の値（`edits`）は字だけの論理値のまま。コアは印入りの値を構造どおりのセルへ置く既存の道（`setFieldCells`）で受ける。

## 設計方針
- 送る値は `SessionState.wire`（欄 → 印入りの値）に別に持つ。`edits` に入れる案は、論理値を前提にする箇所が多く退けた（research F4）
- 形は画面のセルから導出し（先頭が SO でない → full、SI が最後の桁 → full、SI がそれ以外 → compact、SI 無し → open）、
  切り替え・消去で変わった形だけを `jeShapeOverride` に持つ（新しい画面で捨てる）

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`・`EmulatorPane.vue`・`session-controller.ts`・`stores/sessions.ts`
- `packages/tn5250/src/screen/buffer.ts`（`setFieldCells`）

## 依拠する既存の事実
- 空の E の `0e` はコアが `eitherDbcsOn` から置く（`packages/tn5250/src/screen/buffer.ts` の `setFieldValue`・`placeEmptyShift`）
- E の状態の持ち回りは `emit("edit", …, eitherMeta)` → `EmulatorPane.onEdit` → `SessionState.eitherDbcsOn`（`20260927-either-field-so`）
- 印入りの値の送信は `setFieldCells` → `rawDbcsSendValue`（途中の NUL は空白。`20260928-cont-o-cells`）

## インターフェース / データ構造
- `emit("edit", index, logical, { eitherDbcsOn?, wire? })`・`SessionState.wire?: Map<number, string>`
- `jeShapeOf(f)`・`jeExplicit(f, logical, e)`・`jeMeta(f, logical, e)`（`ScreenGrid.vue`）

## 振る舞いの詳細
- full: `SO + 字 + NUL×(桁数−2−2×字数) + SI` / compact: `SO + 字 + SI` / open: `SO + 字`
- Erase EOF: compact の E でカーソルが SI の桁以前なら open へ。Erase Input: compact の E は open へ
- 切り替えで全角になった E は full、半角になった E は形を持たない（`wire` を消す）
- 空の値は `wire` を持たない（コアの `0e` に任せる）
- コア: 並びの中の NUL は空のセル（前半バイトとして読まない）

## エラー処理 / 異常系
- 字が多く full の空きが負になる場合は compact の形で送る（桁の検査はコア側の FIELD_OVERFLOW）

## 受け入れ基準との対応
- AC1: `packages/web-ui/test/je-field-shape.test.ts`（形ごと・消去・切り替え・新しい画面）と `packages/tn5250/test/je-field-send.test.ts`（ACS の測定値のバイト列）
- AC2: `scripts/verify-browser-je-field.mjs`（入力は DSM の JEEDIT、比較は ACS の測定値 J1〜J3）
