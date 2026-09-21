# 仕様: 挿入モードが画面をまたいで残る

## 概要
**達成したい状態**: 画面が変わったら挿入モードが持ち越されない。
**既存の `watch(snapshot, …)` に 1 行足すだけ**。

## 設計方針
- **監視を増やさない。** `EmulatorPane.vue` には既に
  「新しいホスト画面が来たらユーザーのカーソル上書きをリセットする」監視があるので、そこへ合流する。
  同じ契機（新しいスナップショット）で同じ性質（画面ごとに初期化する状態）を扱うため。
- **画面の種類で出し分けない。** ACS は書式開始・WEC・`processClearFMT` の 3 箇所から呼ぶが、
  当 PJ に届くのは**適用後のスナップショット**で、どの経路で来たかは持っていない。
  **新しい画面が来たら戻す**で ACS と同じ観測結果になる（画面が変われば必ず戻る）。
  ※ 「同じ画面が再描画されただけ」でも戻るが、**ACS も書式開始で戻す**ので方向は同じ。
- 理由をコメントに残す——直前の work の規則と絡むため、外されると症状が分かりにくい。

## 対象範囲
| ファイル | 変更内容 |
|---|---|
| `packages/web-ui/src/components/EmulatorPane.vue` | `watch(snapshot, …)` に `insertMode.value = false` |
| `packages/web-ui/test/insert-mode-reset-per-screen.test.ts` | 新規。画面が変わると戻ることを固定 |

## 依拠する既存の事実
- `insertMode` は `ref(false)`（`EmulatorPane.vue:95`）で、`ScreenGrid` へ
  `v-model:insert-mode` で渡る（同 `:999`）。**親が単一の真実**。
- 既存の監視 `watch(snapshot, (snap) => { cursorOverride.value = undefined; … })`（同 `:256`）。
- ACS は `initKeyboard` → `resetInsertMode`（台帳・`20260919-backlog-acs-triage` research N8）。

## インターフェース / データ構造
変更なし。

## 振る舞いの詳細
新しいスナップショット → `insertMode` が false → `ScreenGrid` の編集モデルも上書きで始まる。

## エラー処理 / 異常系
変更なし。

## 要件との対応
- AC1: `watch` の 1 行で満たす。テストは `ScreenGrid` の `insertMode` prop を見る。
- AC2: 行を外す mutation で落ちることを確かめる。
- AC3: コメントに `initKeyboard` / `resetInsertMode` を書く。
- AC4: 新規テストを回す。
