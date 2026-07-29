# タスク: ウィンドウ判定を「受信データの書き込み範囲」で決める

## 第1段: core に材料を足す（挙動は変えない）

- [x] T1: `packages/core/src/screen/types.ts` に `WriteExtent` を追加し、
      `ScreenSnapshot.lastWrite?` を**任意フィールド**として足す
- [x] T2: `packages/core/src/screen/buffer.ts` に書き込み記録を実装する（依存: T1）
  - `setChar` / `setShift` / `setAttr` / `setDbcs` / `eraseRange` / `blankWindowArea` /
    `restoreScreen` / `clearUnit` / `clearUnitAlternate` の 9 箇所
  - `nullNonBypass` は**数えない**（理由をコメントで残す）
  - `eraseRange` は線形範囲を矩形へ畳む（行またぎは全幅）。ループを増やさない
  - `beginRecord()` と `lastWrite` getter を公開し、`snapshot()` へ載せる
  - 書き込み・CLEAR・RESTORE のいずれも無ければ**前回値を残す**
- [x] T3: `packages/core/src/protocol/wtd-applier.ts` の `applyDataStream` 入口で
      `buf.beginRecord()` を呼び、`ApplyResult.lastWrite` に載せる（依存: T2）
- [x] T4: **関門** — 既存テストが全パッケージで通ることを確認する（依存: T3）。
      落ちたら記録の入れ方を見直してから先へ進む

## 第2段: 材料が正しいことを固定

- [x] T5: `packages/core/test/write-extent.test.ts` を新規作成する（依存: T3）
  - ① 窓（SAVE SCREEN → CLEAR なしの部分書き込み）→ `rect` が窓の範囲・`cleared=false`
  - ② 通常画面 / ③ 帳票 / ④ 反転バナー（CLEAR UNIT → 全画面書き込み）→ `cleared=true`
  - 書き込み無しレコードで前回値が残る
  - `eraseRange` の行またぎが全幅になる
  - RESTORE SCREEN で `restored=true`

## 第3段: 判定を切り替える

- [x] T6: `packages/web-ui/src/composables/fkeyLegend.ts` の `detectWindowRect` に門を足す（依存: T5）
  - `snap.gui.windows` の分岐は変えない
  - `snap.lastWrite` **不在時は 1 行も挙動を変えない**
  - `cleared` / `restored` / 矩形なし / 下限（高さ3・幅8）未満 / 画面全体の完全一致 → `null`
- [x] T7: `packages/web-ui/test/window-write-extent.test.ts` を新規作成する（依存: T6）
  - ③④ が `null`、① が従来どおりの矩形
  - `lastWrite` 無しで現行と同じ結果（フォールバックの担保）
- [x] T8: 既存 4 本（`window-view` / `stacked-window` / `reverse-frame-window` /
      `pane-cursor-window`）が改修前と同じく通ることを確認する（依存: T6）。
      **パッケージ dir から実行する**（AGENTS.md）
- [x] T9: 空振り検証 — T6 の門を一時的に外すと ③④ のテストが落ちることを確認する（依存: T7）

## 仕上げ

- [x] T10: `npm run build -w @as400web/web-ui`（vue-tsc 込み）と lint を通す（依存: T1-T9）
