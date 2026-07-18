# 仕様: 接続設定 UI から所有（共有/個人）概念を廃止する

## 概要

UI から所有（共有/個人）の選択・表示・移動を取り除く。
**保存先のルーティング（profiles.json / connections.json）は実装詳細として現状維持**し、
利用者からは見えなくする。ファイル由来の設定は「サーバー設定」と表記する。

## 設計方針

### 方針 1: 保存先ルーティングは変えない（要件の記述を訂正）

requirement には「新規作成は常に個人接続」と書いたが、これは**誤り**。
`newConn()` は現在、認証オフ or admin かつ `profilesEditable` のとき **profile として作成**する。
これを connections 固定に変えると、`connectionInputSchema.strict()` により `autoPdfDir` を持てず、
**ローカル単一利用者が UI から自動 PDF を設定できなくなる**（要件の「対象外: `.strict()` は緩和しない」と衝突）。

したがって `newConn()` の保存先判定は**そのまま残す**。変えるのは「利用者に選ばせない・見せない」ことだけ。

### 方針 2: 「ファイル由来か」の判定は残す

`isProfileForm`（`:52`）は所有 UI ではなく信頼設定欄（`:550`）と注記（`:493`）の表示条件。**残す**。
改名（`isServerSetting` 等）は意味的には妥当だが、差分が膨らむうえ挙動は変わらないため**今回は行わない**
（research の申し送りに対する判断）。

### 方針 3: 表記は「サーバー設定」

「共有」は「機能としての共有」を連想させ、実態（サーバーのファイルで管理される設定）とずれる。
「サーバー設定」は置き場所と編集できない理由の両方を伝える。認証オフでは従来どおり表示しない。

## 対象範囲

**削除**
- `packages/server/src/settings-move.ts`（ファイルごと）
- `packages/server/test/app-settings-move.test.ts`（ファイルごと）

**変更**
- `packages/server/src/app.ts` — `settings-move` の import（`:19`）と登録（`:110-111`）を削除
- `packages/web-ui/src/components/ConnectView.vue` — 所有 UI 一式
- `packages/web-ui/test/connect-view-ownership.test.ts` — 表記追随・所有 UI 非表示の回帰追加
- `README.md` / `docs/UI-DESIGN.md` / `AGENTS.md` — 表記と `passwordEnv` の別軸明記

**触らない**（安全境界）
- `auth.ts` の `requireAdmin()`（`admin.ts` が使用）
- `app.ts` の `canEditProfiles`
- `connection-store.ts` の `connectionInputSchema.strict()`
- `profiles.ts` の信頼設定スキーマ

## インターフェース / データ構造

- `POST /api/settings/move` を**廃止**（破壊的変更。UI 以外の利用者は想定なし）。
- 永続データの形式変更は**なし**。`connections.json` / `profiles.json` はそのまま読める。

## 振る舞いの詳細

### ConnectView.vue の変更点

| 箇所 | 現在 | 変更後 |
|---|---|---|
| `:63` `canChooseOwnership` | admin かつ書込可で true | **削除** |
| `:74` `onOwnershipChange` / `:248` `setOwnership` | 所有の切替 | **削除** |
| `:253` `moveOwnership` | move API 呼び出し | **削除** |
| `:417` チップ | `共有`（`kind shared`） | `サーバー設定`（クラスは `kind server` へ） |
| `:445` チップ | `個人`（`kind personal`） | **削除**（既定が個人なので表示不要） |
| `:471-476` 所有セレクタ | 新規時 admin に表示 | **削除** |
| `:581-583` 移動ボタン | 「共有にする/個人にする」 | **削除** |
| `:64-71` `formTitle` | 新規設定 / 共有設定を編集 / 個人接続を編集 | 新規設定 / **設定を編集**（一本化） |
| `:434` InfoPopover | `共有プロファイル` | `サーバー設定` |
| `:493` 注記 | 「共有設定は全員から見えます…」 | 「サーバー設定は全員から見えます…」に改め、`passwordEnv` の記述は維持 |
| `:239` `newConn` | 保存先を自動判定 | **変更なし**（コメントのみ実態に合わせる） |
| `:52` `isProfileForm` | ファイル由来判定 | **変更なし** |

### 変わらない振る舞い（回帰で守る）

- ファイル由来設定の編集可否＝認証オフ or admin かつ `persistable`（`canEditProfiles`）。
- 一般ユーザーはファイル由来設定が**見えて接続に使えるが編集できない**。
- 自動 PDF/印刷 欄の表示条件＝`isProfileForm && sessionType === "printer"` かつ編集可能。
- 認証オフでは種別以外のチップを出さない。

## エラー処理 / 異常系

- `POST /api/settings/move` は 404（ルート未登録）になる。UI から呼ばないため利用者影響なし。
- 既存 `connections.json` に `owner` が入っているレコードはそのまま有効（可視範囲の判定は不変）。

## 受け入れ基準との対応

| requirement の完了条件 | 満たし方 |
|---|---|
| 新規作成フォームに所有の選択肢が無い | `:471-476` 削除。テストで非表示を確認 |
| 「共有 / 個人」の語が出ない | チップ・タイトル・注記・InfoPopover を更新。テストで文言確認 |
| 「サーバー設定」表記が出る（認証オンのみ） | `:417` を変更し `v-if="!authOff"` 維持 |
| `/api/settings/move` が存在しない | ファイル削除＋`app.ts` から登録削除 |
| 編集可否が現状維持 | `canEditProfiles` に触れず、回帰テストで担保 |
| 自動 PDF/印刷 欄の表示条件が従来どおり | `isProfileForm` を残す。既存テストで担保 |
| 既存ファイルがそのまま読める | スキーマ変更なし |
| ドキュメント更新 | README / UI-DESIGN / AGENTS |

**訂正**: requirement の「新規作成は常に個人接続」は方針 1 により**取り下げる**。
正しくは「**新規作成時に利用者へ保存先を選ばせない**（ルーティングは従来どおり自動）」。
