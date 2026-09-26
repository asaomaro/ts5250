# 決定記録

## D1: `own:<id>`は決定的に導出できない（POST /api/systemsはid自動採番のため）

- **背景**: architecture.md「`own:<id>`（プリンター(スプール表示)/SQL/IFS用の個人設定）の
  導出」は「ファイルURIから安定id（例: sha256先頭16桁）を導出する」としていた。
  実装にあたり`packages/server/src/config-store.ts`の`addSystem`/`updateSystem`を
  読んだところ、**`addSystem`（`POST /api/systems`）は呼び出し側がidを指定できず、
  サーバーが`newSystemId(name)`で自動採番する**——`updateSystem`（`PUT /api/systems/:ref`）は
  既存のidにしか使えず（`getSystem(id)`が無ければ即throw）、upsertではない。
  つまり「`.ts5250`ファイルのURIから`own:<id>`を決定的に計算する」ことは
  既存APIの上ではできない（03-sql-ifs着手時に発覚）。
- **決定**: サーバーが割り当てたidを**拡張機能側でローカルにキャッシュ**する方式に変更する。
  `context.globalStorageUri/systemRefs.json`に`{ [documentUri]: systemId }`の対応表を持ち、
  初回は`POST`で新規登録してidを受け取り保存、2回目以降は保存済みidへ`PUT`で同期する。
  対応表のエントリが失われていたら（globalStorage初期化等）、新規`POST`にフォールバックし
  古いエントリは`connections.json`上に孤児として残る（単一利用者のローカルツールとして許容——
  design.mdの「厳密な排他ロックは取らない」姿勢と同じ判断）。
- **理由・代替案**: 代替案として「サーバー側にidを指定できる登録APIを追加する」ことも
  検討したが、既存サーバーを無改造で使うという要件上の制約（design.md「対象範囲」）に
  反する。`01-embed-ui`のtest工程で見つかった`embed.html`配信バグのような**1行で直る
  欠陥の穴埋め**とは性質が違い、`addSystem`の「idはサーバーが決める」はAPI設計として
  一貫した仕様であって欠陥ではないため、サーバー側を変えず拡張機能側でキャッシュを持つ
  ほうが筋が良い。
- **影響**: architecture.md「`own:<id>`の導出」の記述は不正確だったと訂正する
  （sha256導出ではなく、初回登録時にサーバーが返すidをキャッシュする方式）。
  `Ts5250EditorProvider`は`app !== "emulator"`のとき、`buildConnectPayload`
  （同期・ネットワーク呼び出し無し）とは別に非同期の`syncSystem()`を呼ぶ必要がある。
