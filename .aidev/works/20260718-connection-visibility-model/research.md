# 調査: 所有概念の削除範囲と表記の洗い出し

## 調査の問い

- Q1: `settings-move.ts`（`POST /api/settings/move`）の依存元はどこか。削除の芋づるはあるか。
- Q2: UI 側で所有（共有/個人）に紐づく識別子・表示はどこか。削除後に何が残るべきか。
- Q3: 「共有」表記は接続設定以外にも使われていないか（一括置換の危険）。
- Q4: 既存テストのどれが所有概念に依存しているか。
- Q5: `profiles.json` の編集ゲートは所有概念と独立して成立するか（削除しても壊れないか）。

## 判明した事実

### F1: `settings-move` の依存元は 3 箇所のみ（削除は閉じている）

- `packages/server/src/app.ts:19` — import
- `packages/server/src/app.ts:111` — `registerMoveRoutes(app, {...})` 呼び出し（コメント `:110` 付き）
- `packages/web-ui/src/components/ConnectView.vue:253` — `moveOwnership()` が `fetch("/api/settings/move")`
- テスト: `packages/server/test/app-settings-move.test.ts`（このファイル全体が対象）

`registerMoveRoutes` は `settings-move.ts:82` でのみ定義され、他からの参照は無い。
**`settings-move.ts` とテストをファイルごと削除し、app.ts の 2 行を消せば閉じる。**

### F2: `requireAdmin()` は settings-move 以外にも使われており、削除してはいけない

- `packages/server/src/auth.ts:260` — 定義
- `packages/server/src/admin.ts:39` — `app.use("/api/admin/*", requireAdmin())` で管理者画面 API を保護

`settings-move.ts:83` の `requireAdmin()` 利用は消えるが、**関数自体は admin.ts が使うため残す**。

### F3: UI の所有まわりの識別子（`ConnectView.vue`）

| 行 | 対象 | 削除後の扱い |
|---|---|---|
| 63 | `canChooseOwnership` | 削除（他に用途なし） |
| 74 / 248 | `onOwnershipChange` / `setOwnership` | 削除 |
| 253 | `moveOwnership` | 削除（F1 の API も消える） |
| 417 / 445 | `kind shared` / `kind personal` チップ | 共有側は「サーバー設定」表記へ、個人側は削除 |
| 471-476 | 新規作成の所有セレクタ | 削除 |
| 581-583 | 「共有にする / 個人にする」ボタン | 削除 |
| 52 | `isProfileForm` | **残す**（信頼設定欄の表示条件 `:550` に必要） |

`isProfileForm` は所有 UI ではなく「ファイル由来の設定か」の判定であり、
自動 PDF/印刷 欄（`:550`）と注記（`:493`）の表示条件として**引き続き必要**。

### F4: 「共有」の語は無関係な箇所にも多数ある（一括置換は危険）

`packages/*/src` の「共有 / 個人」ヒットは 41 件だが、大半は**接続設定と無関係**。

- 無関係（触らない）: `core/src/screen/types.ts`, `core/src/index.ts`, `web-ui/.../ScreenGrid.vue`,
  `composables/fitFont.ts`, `composables/fieldValidate.ts`, `stores/workspace.ts`,
  `server/src/ws-messages.ts`, `server/src/session-manager.ts`
  → いずれも「状態を共有する」「個人」等の一般語としての用法。
- 対象: `web-ui/src/components/ConnectView.vue`（24 件）, `server/src/app.ts:54,75,110`,
  `server/src/settings-move.ts`（ファイルごと削除）

**ファイル単位で対象を限定すること。リポジトリ全体の一括置換は禁止。**

### F5: 所有概念に依存する既存テスト

`packages/web-ui/test/connect-view-ownership.test.ts`:

- `:43` 「認証オフでは所有ラベル（共有/個人）を出さない」 → **期待は維持できる**（表記変更後も出ない）
- `:51` 「認証オン（admin）では共有ラベルを出す」 → **表記変更で失敗する**。「サーバー設定」へ更新が必要
- `:80` 「共有が書き込めない構成（editable=false）では編集不可、新規は個人接続へ保存する」
  → 新規は常に connections になるため、**期待は据え置きで通る**（意味は強化される）

`packages/server/test/app-settings-move.test.ts` は全体が削除対象。

### F6: `profiles.json` の編集ゲートは所有概念と独立している

`app.ts:55` の `canEditProfiles` は `認証オフ or admin` かつ `deps.profiles.persistable` で判定しており、
所有セレクタや move API を参照していない。**所有 UI を消してもゲートは無傷**で、
「認証オフ/admin は編集可・一般は不可」は現状のまま維持される。

## 影響範囲

- 削除: `packages/server/src/settings-move.ts`, `packages/server/test/app-settings-move.test.ts`
- 変更: `packages/server/src/app.ts`（import と登録の 2 行＋コメント）,
  `packages/web-ui/src/components/ConnectView.vue`（所有 UI 一式）,
  `packages/web-ui/test/connect-view-ownership.test.ts`（表記追随）
- ドキュメント: `README.md`, `docs/UI-DESIGN.md`, `AGENTS.md`（「共有」表記と `passwordEnv` の別軸明記）

## 実現性 / リスク

- **低リスク**。削除対象の依存が閉じており（F1）、安全境界を担う `canEditProfiles` と
  `connectionInputSchema.strict()` には触れないため、信頼境界は変わらない。
- 唯一の注意点は F4 の**一括置換事故**と、F3 の `isProfileForm` を巻き込んで消さないこと。

## spec への申し送り

- `isProfileForm` は残し、名前が実態（ファイル由来）に合っているか spec で検討する余地はある
  （`isServerSetting` 等）。ただし改名は差分を膨らませるため任意扱い。
- チップの表記は「サーバー設定」。`kind shared` の CSS クラス名も合わせるか要検討。
- 認証オフではチップを出さない現行挙動を維持する（`v-if="!authOff"`）。
