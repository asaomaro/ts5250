# 設計

## 概要
- `deleteWordLength(chars, cursor, isWide)`（純関数）が ACS の範囲を返し、`deleteWord`（SBCS）・`dbcsDeleteWord`（DBCS）・`editAcrossContinued(f, deleteWord)`（継続欄）が削って詰める。`ScreenGrid` が `deleteWord` を公開し、ペインの `onLocal` が呼ぶ。
- 既定: 版 2 の `ctrl+Delete` を `local:delete-word` にし、`ctrl+Backspace` を外す。版 5 の訂正（`CORRECTED_BY_VERSION[5]`）を**キーごとの独立した訂正の配列**にし、値を `null` にすると割り当てを外す。`BINDINGS_VERSION` は訂正だけの版も数える。
- `isEditingKey` は `delete-word` を拒否しない。欄の keydown は、割り当ての無い修飾付き Backspace・Delete を preventDefault して何もしない（ブラウザの語削除が <input> の値だけを変えるのを止める）。

## 対象範囲
- `packages/web-ui/src/composables/fieldEdit.ts`・`useKeymap.ts`、`components/ScreenGrid.vue`・`EmulatorPane.vue`・`KeybindingsPanel.vue`、`stores/keybindings.ts`、README、テスト、`scripts/acs-probe/delete-word.txt`。

## 依拠する既存の事実
- 編集モデルは `EditState`（`chars`・`cursor`）。SBCS の削除は `del`（詰めて欄の長さを保つ）、DBCS は論理値から削って `padDbcs`。`isWideForDbcs`（センチネルを除く全角判定）。継続欄は `editAcrossContinued`（`ScreenGrid.vue`）。

## インターフェース / データ構造
- `deleteWordLength(chars, cursor, isWide = () => false): number`・`deleteWord(state): EditState`・`LocalEditAction` に `"delete-word"`・`Correction { from; to: Record<string, BindingTarget | null> }`。

## 振る舞いの詳細
- 空白・全角は 1 字。半角の語は、頭（直前が空白・全角・欄の先頭）なら語＋続く空白、途中ならカーソルから語の終わりまで。語の終わりは空白・全角・欄の終わり。カーソルが末尾の後ろなら何もしない。

## エラー処理 / 異常系
- 保護欄・欄の外は操作員エラー（他のローカル編集キーと同じ）。

## 受け入れ基準との対応
- AC1〜AC4: `delete-word.test.ts`・`keybindings.test.ts`・`host-error-mode.test.ts`。AC5: mutation 22 通り。
