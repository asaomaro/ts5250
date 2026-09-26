# タスク: プリンター(スプール表示)・SQL・IFSの個人設定同期

親work design.md「設計方針3」（訂正後）・architecture.md「`own:<id>`の導出」
（`decisions.md` D1で訂正）を実装する。このsubtaskの範囲は`vscode-extension/`のみ
（`packages/server`・`packages/web-ui`は無変更——両方とも既存の仕組み
（`/api/systems`・`system` prop）をそのまま使う）。

## 実装方針

1. `systemSync.ts`（`vscode-extension/src/`）を新規作成する。ローカルの対応表
   （`systemRefs.json`）とサーバーの`/api/systems`への`POST`/`PUT`を持つ、
   `vscode`モジュールに依存しない純粋ロジック
2. `ts5250EditorProvider.ts`を拡張し、`app !== "emulator"`のときだけ`syncSystem()`を
   呼んで`systemRef`をペイロードへ乗せる（emulatorの経路・ペイロードは変更しない）
3. 実プロセス統合テストで、実際のサーバーへ登録→再同期→GETで確認する

## 作業順序と依存関係

下の「依存」欄に従う。T1は独立、T2はT1に依存、T3はT1に依存（T2には依存しない
——`ts5250EditorProvider`を経由せず`systemSync`を直接呼ぶ）。

## リスク / 留意点

- `POST /api/systems`はidを自動採番するため、**初回登録時の応答からidを受け取って
  保存する**（`decisions.md` D1）。保存に失敗する・対応表が消えている場合は
  新規`POST`にフォールバックする（孤児が増えるだけで実害は無い。design方針どおり）
- `PUT /api/systems/own:<id>`が404（サーバー再起動でconnections.jsonが
  リセットされた等でエントリが実在しない）を返したら、同じく新規`POST`に
  フォールバックし、対応表を新しいidで上書きする
- パスワードは`buildConnectPayload`とは別経路（`syncSystem`が直接
  `ExtensionSecretCrypto`で復号し、サーバーへ平文で渡す。サーバー側が
  自分の鍵で`passwordEnc`として保存し直す——design.md「設計方針3」の
  「暗号文を二重に持つ」設計どおり）
- **SQL/IFS/プリンター(スプール表示)の実際のREST呼び出し
  （`/api/host/spools`・`/api/sql/*`・`/api/ifs/*`）自体は`packages/web-ui`の
  既存コンポーネント（`SpoolPane.vue`等。01-embed-ui で組み込み済み）が行う。
  このsubtaskの責務は`systemRef`を用意するところまで**

## テスト方針

- `systemSync.ts`はvitestで単体テストする（`fetch`を注入可能にし、モックで検証）
- `ts5250EditorProvider.ts`の統合はモックの`vscode`＋モックの`fetch`で検証する
- 実プロセス統合テスト（T3）で、実際に起動したサーバーへ登録・再同期・
  `GET /api/systems`での確認を行う（`.env`/`.env.verify`は使わない——
  ここで見るのは登録の正しさであって実機接続ではない。実機接続は01-embed-uiの
  `SpoolPane.vue`等が既に担っており、このsubtaskでは新しい接続経路を作らない）

## タスク

- [x] T1: `vscode-extension/src/systemSync.ts`を新規作成する（`systemRefs.json`の
      読み書き・`POST`/`PUT /api/systems`呼び出し・404時の新規`POST`フォールバック）。
      単体テストを書く（`fetch`を注入し、初回`POST`→2回目`PUT`→404フォールバックの
      3パターンを検証）
      対象: 新規（参照: `packages/server/src/config-routes.ts`の`SystemInput`・
      `POST`/`PUT /api/systems`ルート、`decisions.md` D1）
      依存: なし
      AC: AC8
- [x] T2: `ts5250EditorProvider.ts`を拡張し、`app !== "emulator"`のとき
      `syncSystem()`を呼んで`systemRef`を`ConnectPayload`へ乗せる
      （`user`/`password`は直接ペイロードへ乗せない。design.md「設計方針3」）。
      既存テストを壊さず、printer/sql/ifsの新しいテストを追加する
      対象: `vscode-extension/src/ts5250EditorProvider.ts`の`buildConnectPayload`/
      `sendConnect`/`handleSave`周辺（既存実装を拡張）
      依存: T1
      AC: AC1, AC8
- [x] T3: T1の実プロセス統合テストを書く（実際に`packages/server`をspawnし、
      `syncSystem()`→`GET /api/systems`で登録内容を確認、2回目の`syncSystem()`が
      同じidへ`PUT`することを確認）
      対象: `vscode-extension/test/`配下に新規
      依存: T1
      AC: AC8
