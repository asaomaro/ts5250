# 仕様: 定義ベースの一覧

## 設計判断

### D1. 定義が行、実行状態は突き合わせる

`listSessions(user)` で `sessionType` を絞り、`listPrinters(user)` /
`WatchRegistry.list(user)` から `ref` で突き合わせる。
**動いていなければ `stopped`**——「定義はあるが待ち受けていない」がその意味そのもの。

### D2. `PublicSession` に足すのは**フラグ 2 つと派生 1 つ**だけ

| 追加 | 理由 |
|---|---|
| `autoStart` | **信頼設定ではない**（パス・コマンド・秘密に触れない）ので誰にでも返す。`dtaqWatch` と同じ理屈 |
| `service` | 「サービスか」は一覧に必ず要る。**それ自体はパスでもコマンドでも秘密でもない** |
| `hasOutput` | `autoPdfDir` / `autoPrint` の**有無に畳んだ派生値**。中身は出さない |

**`printer` ブロックそのものは返さない**（既存の扱いを変えない）。
UI は「値は返らない＝保存で上書き」を承知の上で作られており
（`ConfigCard.vue` のコメント）、そこに手を入れるのは本 work の範囲外。

### D3. 直接接続は出さない

定義を持たないプリンター（ブラウザが host を直指定）は、
**画面のセッションタブが持つもの**であって**サービスの一覧ではない**。
`ref` で突き合わせるので自然に落ちる。

### D4. 認可はルートに書かない

`listSessions(user)` / `listPrinters(user)` / `WatchRegistry.list(user)` に委ねる。
**条件分岐を散らすと食い違う**。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `config-types.ts` | `PublicSession` に `autoStart` / `service` / `hasOutput` |
| `config-store.ts` | `publicSession` で 3 つを埋める |
| `host-printers.ts` | **定義ベースに作り直し**＋`GET /api/watches` 新設 |
| `app.ts` | `resolver` と `watches` を渡す |
| `host-printers.test.ts` | 作り直し（11 件） |
