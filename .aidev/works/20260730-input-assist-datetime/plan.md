# 計画: 入力支援 UI（F4 の導線）と、datepicker を作らない判断

## 実装方針

**調査が実装より重い作業**。実機で前提が崩れたので、コードは `F4` の導線 1 本に絞る。
検出（純関数）→ 設定 → UI → テスト → 文書の順。

subtask には割らない（変更は 6 ファイル・1 機能）。

## 作業順序と依存関係

1. `fkeyLegend.ts` に `detectPromptKey()`（依存: なし）
2. `viewSettings.ts` に `promptHint`（型・`VIEW_ITEMS`・`FALLBACK`）（依存: なし）
3. `opMessages.ts` に文言（依存: なし）
4. `ScreenGrid.vue` にボタン（依存: 1,2,3）
5. `EmulatorPane.vue` で設定を渡す（依存: 4）
6. テスト（依存: 5）
7. 文書: `scripts/README.md` に 3 本を登録、backlog に 5 件の結論（依存: 6）

## リスク / 留意点

- **画面に重ねる部品は矩形選択・コピーを壊しやすい**。`optHints` で一度踏んだので、
  同じ作法（キーを購読しない・`@mousedown.stop.prevent`・`tabindex="-1"`）を守る。
  **テストで不変条件として固定する**（`opt-hints-ui.test.ts` に倣う）
- **ラベルを言い換えない**。`F4` の意味はホストが決めるので、表示はホストの凡例から取る
- 設定を足すのは `VIEW_ITEMS` の 1 か所（メニューとキー設定に自動で出る）。2 か所に書かない
- **backlog を「できなかった」で終わらせない**。次に読む人が同じ調査を繰り返さないよう、
  実測の値と再現手段（スクリプト名）を残す

## テスト方針

### web-ui（`packages/web-ui/test/prompt-hint.test.ts`）

- `detectPromptKey()`: `F4` の凡例があれば返す / 無ければ null / **ラベルはホストのまま** /
  `F3` だけの画面では null / 窓の外の `F4` は拾わない
- `ScreenGrid`:
  - 設定 OFF では出ない
  - 設定 ON ＋ `F4` あり ＋ 入力欄にフォーカスで出る
  - 凡例に `F4` が無ければ出ない
  - フォーカスが外れると消える
  - **押すと `aid("F4")` が飛ぶ**
  - **キーイベントを購読していない**（ボタンの上でのキー操作が親へ通る＝矩形選択が生きる）
  - `tabindex="-1"`（タブ順を変えない）
- `viewSettings`: 既定が OFF / `VIEW_ITEMS` に出る（メニューとキー設定の両方に効く証拠）

### 空振り検証（mutation）

- `detectPromptKey` の `key === "F4"` を `F3` にする
- 設定の判定（`promptHint === false` で出さない）を外す
- 既定を ON にする
- `@mousedown.stop.prevent` を外す
- ラベルを固定文字列（"プロンプト"）に置き換える
- `tabindex` を 0 にする
