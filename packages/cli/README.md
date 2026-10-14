# @ts5250/cli

コマンドラインの入口 2 つ。

```sh
ts5250 serve [--port 3400 …]        # サーバーだけを起動（as400-5250-server と同じ。前面で動く）
ts5250 [セッション名]               # サーバーを起動し、同じ端末で 5250 の画面を開く
ts5250 --host H --user U --password-env 環境変数名   # ホストを直接指定

ts5250ctl list                      # MCP ツールの一覧
ts5250ctl describe open_session     # 引数の仕様
ts5250ctl open_session --session srv:名 [--readOnly true]
ts5250ctl <ツール名> --json '{"引数":値}'
```

- `ts5250` はカレントに `.env` があれば `--env-file=.env`、`profiles.local.json`（無ければ `profiles.json`）があれば
  `--profiles` を付けてサーバーを起動する（`start.sh` と同じ決め）。`.env` は読まず、サーバーへ渡すだけ。
- サーバーが既にそのポートで動いていれば起動せず再利用する。端末を閉じると、起動したサーバーも止まる。
  サーバーのログは一時ディレクトリの `ts5250-server-<ポート>.log`。
- 画面はサーバーの WebSocket 越しに `@ts5250/terminal` で操作する（セッションはサーバーが持つので、
  ブラウザ・MCP と同じものを見られる。`--attach セッションID`）。端末の操作は `ts5250-term --help`。
- `ts5250ctl` の接続先は `--url`（既定 `$TS5250_URL`、無ければ `http://127.0.0.1:3400/mcp`）。
  ツール・引数はサーバーが返すものをそのまま使うので、ツールが増えても変更は要らない。
