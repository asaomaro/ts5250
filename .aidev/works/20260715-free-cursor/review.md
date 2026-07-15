# レビュー: 画面全体の自由カーソル

## ラウンド 1（coding → review）

対象差分: `EmulatorPane.vue` / `ScreenGrid.vue` / `useCursor.ts` ＋ テスト。
観点: 要件適合 / 正確性 / 規約適合(AGENTS.md) / 保守性。

### 指摘

- **must（正確性）R1-1: 欄内非先頭桁へ矢印で入ると論理カーソルが欄先頭へ巻き戻る**
  `reconcileFocus` の field 分岐で `el.focus()` が `onInputFocus` を発火し、そこで `emit("cursor", f.row, f.col)`
  （＝欄先頭）が親の `onCursor` を呼んで `cursorOverride` を欄先頭に上書きする。その後 `setSelectionRange(caret)` で
  native キャレットは目的桁に置かれるため、**論理カーソル（cursor.value）と native キャレットが不一致**になる。
  例: (5,12) から ArrowDown で欄(6,10,len8)へ入ると caret は col12 だが cursor.value は (6,10)。直後の AID/上下移動が
  ずれる。→ field 分岐末尾で `cursorOverride` を目的 `pos` に再確定して解消。

- **must（正確性）R1-2: DBCS 全角文字を跨いで右移動できない（カーソルが lead に貼り付く）**
  `moveCell` が `moveCursor` 後に一律 `roundToDbcsLead` する。lead 桁で ArrowRight すると tail へ進むが tail→lead に
  丸め戻され、**右へ進めず停止**する。丸めは「位置確定・クリック・左/上/下」には正しいが、右移動だけは tail を
  飛び越える必要がある。→ `moveCell` を方向対応にし、right かつ tail 着地時は 1 桁先へ送る。

### 対応

R1-1・R1-2 とも coding へ差し戻して修正（下記 decisions D4・D5）。回帰テストを追加:
- 欄の非先頭桁へ矢印で入った後 AID に正しい桁が載る（R1-1）。
- DBCS lead から ArrowRight で tail を飛び越えて次セルへ進む（R1-2）。

## ラウンド 2（再 review）

R1-1・R1-2 の修正（decisions D4・D5）を確認。

- R1-1: `reconcileFocus` field 分岐で `setSelectionRange` 後に `cursorOverride = pos` を再確定。回帰テスト
  「欄の非先頭桁へ矢印で入っても論理カーソルが桁を保つ」で (6,12) が AID に載ることを確認。
- R1-2: `moveCell` を方向対応にし、tail 着地かつ right なら 1 桁先へ。回帰テスト「DBCS 全角を跨いで右移動」で
  lead→(tail 飛ばし)→次セルへ進むことを確認。
- 非回帰: web-ui 113 / monorepo 全 290 green、`vue-tsc -b && vite build` クリーン。
- 規約(AGENTS.md): 意図優先コメント・vue-tsc ビルド必須・秘匿情報なしを満たす。

**判定: must/should なし（指摘解消済み）。** deliver へ（差分は複数ファイル横断だが単一コンポーネント群・
ロジックは useCursor に集約され明快なため walkthrough は不要と判断）。

### 環境依存で未検証（deliver の既知の制約へ）
- `onGridClick` の pixel→セル座標精度（実測字幅）は jsdom がレイアウト 0 のため自動検証外。実機目視に委ねる。
