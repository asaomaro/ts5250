# 計画: IFS ファイルブラウザ（メタ plan）

この work は **subtask に分割する**。本ファイルは割れ目と順序だけを定義するメタ plan で、
各 subtask の詳細な `tasks.md` は**その subtask の plan 工程で作る**（ここでは作らない）。

## 実装方針

下層から積む。各 subtask が**単独で検証できる**ことを割れ目の条件にした。

```mermaid
graph LR
  S1["01-core-listfiles<br/>プロトコル層 + 接続層"]
  S2["02-server-api<br/>zip-writer + ルート"]
  S3["03-web-ui<br/>IfsPane + 登録"]
  S1 --> S2 --> S3
```

## 割れ目（subslug 境界）

### 01-core-listfiles

**範囲**: `ifs-types.ts`（新規）、`ifs-datastream.ts` への `parseListEntry` / `buildListFilesRequest` /
`buildCreateDirRequest`、`ifs-connection.ts` への `listFiles()` / `makeDirectory()`、
`rawConnection` の削除、`transport/host-connection.ts` の `requestStream` と `frame-trace.ts` の追従を正式化。

**単独で検証できる理由**: 応答解析は `research.md` F1-3 の実機 hex ダンプを固定データにして
単体テストできる。接続層は `tools/hostserver-check` の `ifs-list` で実機に当てられる。

**この subtask が負う設計上の規約**（`design.md`）:
- 連鎖は必ず終端まで読み切る。受信側で打ち切らない
- 解析に失敗して連鎖を放棄したら接続を破棄する
- 終端は `0x8001`（rc=18）で判定する。連鎖指示では判定しない（ハングする）
- `templateLength` は宣言値を読む。92 を埋め込まない
- 固定属性は offset 50 の 4 バイト。2 バイトで読むと全て 0 になる
- mkdir の CP は `0x0001`（ファイル名の `0x0002` ではない）。`0x8001` は mkdir では正常応答

### 02-server-api（依存: 01）

**範囲**: `zip-writer.ts`（新規）、`ifs-collect.ts`（新規）、`host-ifs.ts`（新規・ルート 7 本）、
`app.ts` へのルート登録、`main.ts` への CLI 引数 2 つ（4GB 以上は起動時に弾く）。

**単独で検証できる理由**: `zip-writer.ts` は IFS を知らないので、作った ZIP を `unzip -t` に通せば実機不要で検証できる。
ルートは `buildApp()` + `app.request()` で入力検証とステータスを固定できる。

**注意**: `zip-writer.ts` は 01 に依存しないので、01 と並行して着手してよい。

### 03-web-ui（依存: 02）

**範囲**: `IfsPane.vue`（新規）、`useIfsTree.ts` / `usePreview.ts`（新規）、
パネル登録 4 箇所（`paneLabels.ts` の 2 箇所・`WorkspaceNode.vue`・`LauncherPane.vue`）。

**注意**: `paneLabels.ts` の 2 箇所は同時に直す。片方だけだと `web-ui/test/csv.test.ts:79-84` が落ちる。

## 作業順序と依存関係

1. **01-core-listfiles**（依存: なし）
2. **02-server-api**（依存: 01。ただし `zip-writer.ts` だけは並行可）
3. **03-web-ui**（依存: 02）

## リスク / 留意点

- **spike の未コミット変更が作業ツリーにある**。`requestStream` / `frame-trace.ts` の追従 /
  `buildListFilesRequest` / `tools/hostserver-check` の検証コマンド 2 つ / `rawConnection` の暫定露出。
  01 は**これを正式な形に整える**作業であって、ゼロから書くのではない
- `rawConnection` の削除漏れ。spike 用の露出が本番に残る
- 実機検証は test 工程に集約する。`/home/USER/ifsdemo/` にファイル・ディレクトリ・
  シンボリックリンクが 1 つずつ揃えてある
- 実効スループット約 100KB/s。zip とプレビューの上限はこれを前提に決めてある

## テスト方針

| 層 | 実機なしで確かめること | 実機で確かめること（test 工程） |
|---|---|---|
| core プロトコル | 実機 hex ダンプを固定データにした `parseListEntry` の解析。境界（`.`/`..` 除外、symlink、ディレクトリ判定） | 実ディレクトリの一覧、ページング、mkdir |
| core 接続 | — | 連鎖の終端判定、解析失敗時の接続破棄 |
| zip-writer | 作った ZIP を `unzip -t` に通す。非 ASCII 名、空ディレクトリ、圧縮が効かないデータ | — |
| server | 入力検証・ステータス固定（`buildApp()` + `app.request()`）、上限超過の 413 | 実ファイルの取得と zip の展開一致 |
| web-ui | `mount` + `globalThis.fetch` 差し替えでツリー展開・ページング・エラー表示 | 実ブラウザでテキスト/PDF/画像のプレビュー |

## 親 work の完了条件

3 つの subtask がすべて deliver 済みになり、`requirement.md` の受け入れ基準が満たされること。
`.aidev/backlog/hostserver.md:177` のチェックは最後の subtask の deliver 時に入れる。
