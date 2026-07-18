# タスク: 接続設定のサーバー一元管理

## 1. secret-crypto
- [x] T1: `packages/server/src/secret-crypto.ts` を作成（`SecretCrypto.fromEnv`／`encrypt`／`decrypt`、AES-256-GCM、`v1:iv:tag:ct`、鍵は hex64/base64 32byte 検証）
- [x] T2: secret-crypto の単体テスト（往復一致・改ざん検知・鍵長不正 throw・未設定 undefined）

## 2. connection-store
- [x] T3: `packages/server/src/connection-store.ts`：zod strict スキーマ（ConnectionRecord/ConnectionInput、printer フィールド不在）＋`PublicConnection`（依存: T1）
- [x] T4: `ConnectionStore`（fromFile/listForUser/get/add/update/remove/resolveConnectOptions/save）を実装、認可は `assertOwner`、password↔secretEnc の暗復号（依存: T3）
- [x] T5: connection-store の単体テスト（認可・owner フィルタ・暗号化・update の password 据え置き/削除/再暗号化・strict 拒否・atomic save）（依存: T4）

## 3. REST + app 配線
- [x] T6: `packages/server/src/connections.ts`：`registerConnectionRoutes`（GET/POST/PUT/DELETE、owner スコープ、エラー写像 403/404/400、password 非露出）（依存: T4）
- [x] T7: `app.ts` に配線（`AppDeps`/`ToolDeps` に `connections` 追加、ルート登録）（依存: T6）
- [x] T8: REST の統合テスト（201/200/403/404/400、認証オン/オフの一覧差、PublicConnection が secret を返さない）（依存: T7）

## 4. open ID 参照
- [x] T9: `WsClientMessage` open に `connection?: string` を追加（型・共有）（依存: T3）
- [x] T10: `ws-handler.ts` の `onOpen`/`onOpenPrinter` に connection 解決を追加（優先順位 connection>profile>direct、resolve 内 assertOwner、復号失敗 warn）（依存: T4,T9）
- [x] T11: `mcp-tools.ts`/`mcp-server.ts` の open 系に connection 参照を通す（deps.connections）（依存: T4,T9）
- [x] T12: open ID 参照のテスト（解決・owner 拒否・優先順位）（依存: T10）

## 5. main 配線
- [x] T13: `main.ts` に `--connections <file>` と master key ロード（`SecretCrypto.fromEnv`）を配線、deps へ注入。未指定時は空ストアで後方互換（依存: T4,T7,T10）
- [x] T14: 起動挙動テスト（未指定で後方互換、master key 不正で起動 throw、未設定で password 保存 400）（依存: T13）

## 6. web-ui
- [x] T15: `packages/web-ui/src/stores/connections.ts`：fetch ベースの reactive ストア（list/create/update/remove、hasSecret 保持）（依存: T7）
- [x] T16: `ConnectView.vue` を API 化（一覧を connections ストアから、開くを `{connection: id}`、パスワードは値送信＋`hasSecret` 表示、種別チップ/トグルは維持）（依存: T15）
- [x] T17: `stores/settings.ts` の接続 CRUD 撤去（localStorage 接続読み書きを廃止。ビュー設定 `as400.connectView` は残す）（依存: T16）
- [x] T18: web-ui テスト更新（connections ストアの CRUD、ConnectView が localStorage 接続を使わない、既存テスト green 維持）（依存: T16,T17）

## 7. ドキュメント
- [x] T19: README／`.env` 記載（`AS400_SECRET_KEY` 生成手順、`--connections`、接続設定のサーバー保存・認証連動の説明）（依存: T13,T17）

## 完了確認
- [x] T20: `npm run build` / `npm test` / `npm run lint` が全て green
