# 計画: 接続設定 UI から所有概念を廃止する

## 実装方針
サーバー側（API 廃止）→ UI（所有 UI 削除・表記変更）→ テスト追随 → ドキュメント の順。
サーバーを先に落とすと UI の `moveOwnership` が死にコードとして残るため、UI は直後に続けて処理する。
安全境界（`requireAdmin` / `canEditProfiles` / `.strict()`）には触れない。

## 作業順序と依存関係
1. `settings-move.ts` と専用テストを削除、`app.ts` から登録を外す（依存: なし）
2. ConnectView から所有 UI（セレクタ・移動ボタン・チップ・関連関数）を削除（依存: 1）
3. 表記を「サーバー設定」へ（チップ・InfoPopover・注記・フォーム見出し）（依存: 2）
4. 既存テストの表記追随＋所有 UI 非表示の回帰追加（依存: 3）
5. ドキュメント更新（README / UI-DESIGN / AGENTS）（依存: 3）
6. 全体検証（tsc / vue-tsc ビルド / 全テスト / lint）（依存: 4,5）

## リスク / 留意点
- **一括置換事故**: 「共有」は core/screen 等で一般語として多用。対象は ConnectView.vue と app.ts のみ（research F4）。
- **巻き込み削除**: `isProfileForm` は信頼設定欄の表示条件、`requireAdmin()` は admin API の保護。どちらも残す（F2/F3）。
- **保存先ルーティングは変えない**（spec 方針1）。`newConn` のロジックは維持しコメントのみ調整。

## テスト方針
- 削除: `app-settings-move.test.ts`。
- 追加/更新: `connect-view-ownership.test.ts` に「所有セレクタ・移動ボタンが出ない」「サーバー設定表記」を追加。
- 現状維持の担保: 編集可否（認証オフ/admin/一般）と自動出力欄の表示条件は既存テストを残す。
