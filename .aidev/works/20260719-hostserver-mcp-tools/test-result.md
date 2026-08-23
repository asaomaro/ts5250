# テスト結果

## 自動テスト

```
tsc -b        通過（エラーなし）
eslint        クリーン（packages/server 全体）
vitest server 27 files / 253 tests 通過（うち本作業の新規 22 件）
```

既存 231 件はすべて緑のまま。`errorResult` を拡張したが 5250 系の応答形は変えていない。

新規テスト（`packages/server/test/host-server-tools.test.ts`）が固定した不変条件:

- ホストサーバー経由 10 本が登録されている／既存 5250 ツール 19 本が消えていない（後方互換）
- `host_` 接頭辞で経路が判別でき、`list_spools`（push 型）と `host_list_spools`（pull 型）が併存する
- **全 10 本の入力スキーマに `user` / `password` / `host` が存在しない**（D13）
- `system` / `session` 未指定は `CONFIG_ERROR`、未知の参照は `SESSION_NOT_FOUND`
- 資格情報を持たない接続設定では**10 本すべて**が理由の分かる `CONFIG_ERROR` を返す
- `hostAuthFrom` が `tls` をオブジェクトのまま渡す（boolean に潰さない）
- 上限超過の `maxRows` / `max`、不完全な `id` を拒否する

### テストを直した箇所（実装ではなく期待値が誤っていた）

「存在しない参照」に `ConfigResolver` が返すのは `CONFIG_ERROR` だと想定して書いたが、
実際は **`SESSION_NOT_FOUND`** だった。未指定（`CONFIG_ERROR`）と区別されるのは妥当なので、
テスト側を実態に合わせた。

## 実機検証（PUB400・CCSID 273/939）

**10 本すべてを実際に叩いた。** 検証は `buildMcpServer` に InMemoryTransport の MCP クライアントを
繋ぎ、`profiles.local.json` の実接続設定（`srv:pub400.com`）を解決させて実行した
（＝本番と同じ解決・接続経路を通る）。検証スクリプトはリポジトリに残していない。

| ツール | 結果 | 確認内容 |
|---|---|---|
| `host_sql` | ✅ | `SELECT CURRENT SERVER, CURRENT DATE` → `PUB400` / `2026-07-19`。列メタデータ（typeName/ccsid/nullable）も取得 |
| `host_command` | ✅ | `CHGJOB CCSID(273)` 成功（returnCode 0） |
| `host_command`（失敗系） | ✅ | `NOSUCHCMD` → `success:false` / `CPD0030`＋`CPF0001` を構造化して取得。**例外にせずメッセージを返す設計どおり** |
| `host_list_jobs` | ✅ | SCPF / QSYSARB / QSYSARB2 の 3 件 |
| `host_list_objects` | ✅ | TESTLIB の 5 件（CLRTPGM / INLPGM / INPPGM / A1 / CLRTDSP） |
| `host_list_users` | ✅ | 4 件（ENGMTZ / USER / SANDEP981 / VENSUJA） |
| `host_list_spools` | ✅ | QPJOBLOG 等。OUTQ・ページ数・サイズ・日時まで取得 |
| `host_get_spool`（text） | ✅ | 744 行。先頭行に `5770SS1 V7R5M0 220415 … Job Log … PUB400` |
| `host_get_spool`（pages） | ✅ | 12 ページ／1 ページ目 62 行 |
| `host_write_file` | ✅ | `/home/USER/as400web-verify.txt` に 7 バイト書き込み |
| `host_read_file` | ✅ | 同ファイルを読み戻し `"verify\n"` が一致（往復確認） |
| `host_command`（RMVLNK） | ✅ | 検証ファイルを削除（`CPCA089 Link removed.`）。**D3 の「削除は host_command で足りる」を実証** |
| `host_call_program` | ⚠ 経路のみ | `QGYOLSPL` にパラメータ 0 個で呼び、`MCH0802 Total parameters passed does not match number required.` を取得 |

### `host_call_program` の扱い（正直な記録）

**プログラム呼び出しが成功したわけではない。** パラメータ 0 個は明確な誤りで、IBM i が
`MCH0802` を返した。これが確認しているのは「プログラムを特定して呼び出し、
IBM i からの応答を構造化して受け取る経路が通っている」ことまでである。

正しいパラメータ列での成功は**未検証**。ただし同じ `conn.call()` は
`listSpooledFiles` / `listJobs` / `listObjects` / `listUsers` が内部で使っており、
それらは上表のとおり実データを返している——**呼び出し経路自体は実証済み**と言える。

## 実測: 接続の所要時間（spec D2 の検証）

単発完結モデルの前提だった「接続コスト」を測った。1 ツール呼び出し = 接続確立（signon＋目的サーバーの
2 接続）＋操作＋切断の全体。

| 操作 | 所要 |
|---|---|
| `host_sql`（1 行） | 6,191 ms |
| `host_command` | 4,796 / 4,953 / 4,570 ms |
| 各種一覧 | 4,931 〜 5,226 ms |
| `host_write_file` / `host_read_file` | 4,120 / 3,983 ms |
| `host_list_spools`（別実行） | 6,917 ms |
| `host_get_spool`（text 744 行） | 7,720 ms |
| `host_get_spool`（pages 12 ページ） | 9,645 ms |

**評価: 概ね 4〜7 秒/呼び出し。** 内訳の大半はネットワーク往復で、PUB400 は
インターネット越しの公開ホスト＋TLS である。処理量に比例していない
（1 行の SELECT も 5 件の一覧もほぼ同じ時間）ことが接続確立支配であることを裏づけている。

**判断: 単発完結のまま進める（plan に戻さない）。**

- MCP ツールは対話的に単発で叩かれる用途であり、5 秒は許容範囲
- 遅さの主因は**設計ではなく回線**。LAN 内の IBM i では大幅に短くなると見込まれるが、
  **これは未検証の見込みであり事実として断定しない**
- プールを入れると「いつ閉じるか」「ユーザーをまたいで再利用しないか」という
  認可上の難しさが増える。**実測が許容範囲である以上、複雑さを先に払わない**

→ backlog に「LAN 内 IBM i での所要時間の実測」と「必要になった場合の接続プール」を
   残す価値がある（deliver 時に追記）。

## 未検証の範囲（引き継ぎ）

- `host_call_program` の**正しいパラメータ列での成功**
- `truncated: true` になる規模の SELECT（PUB400 に十分な行数の表を用意していない）
- `host_read_file` / `host_write_file` の大きなファイル（core 側の複数ブロック読み書きが未検証。backlog 記載）
- 認証オン環境での一般ユーザー／admin の出し分け（単体テストでは `ConfigResolver` の
  既存テストに委ねており、ホストサーバーツール経由では未実施）
