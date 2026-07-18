# レビュー: 接続設定 UI から所有概念を廃止する

## ラウンド 1

### 観点別チェック

**要件適合**
- 受け入れ基準 8 項目を機械確認で全て OK（move API 不在 / 所有 UI 不在 / 共有・個人の語不在 /
  canEditProfiles 健在 / requireAdmin 健在 / .strict 維持 / isProfileForm 健在 / 既存ファイル読込）。

**安全境界（最重点）**
- `canEditProfiles`（app.ts）・`requireAdmin()`（admin.ts）・`connectionInputSchema.strict()`・
  `profiles.ts` の信頼設定スキーマ、いずれも**無変更**。信頼境界は不変。
- `requireAdmin()` は settings-move 削除で参照が 1 つ減るが、admin.ts が使用しており削除していない（research F2）。

**巻き込み削除の回避**
- `isProfileForm` を残したため、自動 PDF/印刷 欄の表示条件（`isProfileForm && sessionType==='printer'`）は不変。
  既存テスト「プリンター種別の編集でだけ PDF 出力設定が出る」が通ることで担保。

**一括置換事故の回避**
- 変更したのは `ConnectView.vue` / `app.ts` / ドキュメントのみ。`core` 等の一般語「共有」には未接触（research F4）。

**保存先ルーティング**
- `newConn()` の判定ロジックは維持（spec 方針1）。変数名のみ `shared` → `server` に改名しコメントを実態に合わせた。
  ローカル単一利用者が UI から自動 PDF を設定する導線は保たれている。

### 指摘

- [nit] Prettier 警告が `ConnectView.vue` / `app.ts` に出るが、**main でも同じ警告が出る既存状態**であり
  本変更由来ではない。整形すると差分が膨らむため見送り（lint=eslint はクリーン）。
- [nit] `isProfileForm` は実態が「ファイル由来か」なので `isServerSetting` 等が適切だが、
  spec 方針2 のとおり今回は改名しない（挙動不変で差分だけ増えるため）。
- [対応済] `newConn()` と `doConnect()` の間の空行が失われていたため復元。

### 判定

must=0 / should=0 / nit=2（いずれも対応不要と判断）。deliver へ進む。
