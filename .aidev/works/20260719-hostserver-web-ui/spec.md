# 仕様: SQL ペイン（Web UI からの SQL 実行と CSV ダウンロード）

## 1. 決定事項

### D1. ブラウザから任意の SELECT を受け付ける ★セキュリティ判断

**決定**: `/api/host/sql` は任意の SQL 文字列を受け取る。

requirement の指摘どおり、前作業（MCP）の D1 をそのまま流用**しない**。あちらの根拠は
「MCP には既に `run_steps` があり任意 CL を打てる」で、ブラウザには当てはまらない。

**この作業で新たに取った根拠 — 実機で測った事実:**

`query` が「SELECT 専用」であることは実装の性質としては分かっていたが、
**セキュリティ境界として成立するかは検証していなかった**ので、PUB400 で確かめた。

| 投げた SQL | 結果 | 副作用 |
|---|---|---|
| `SELECT 1 FROM SYSIBM.SYSDUMMY1` | 成功 | — |
| `VALUES 1` | 成功（結果セットを返す） | — |
| `DELETE FROM TESTLIB.A1 WHERE 1=0` | `PROTOCOL_ERROR`（結果セットが無い） | — |
| `CREATE TABLE TESTLIB.ZZPROBE (C1 INT)` | `PROTOCOL_ERROR` | **作られていない**（`DLTOBJ` が `CPF2105 not found`） |
| `CALL QSYS2.QCMDEXC('CRTDTAARA …')` | `PROTOCOL_ERROR` | **作られていない**（別経路の一覧で `count=0` を確認） |
| `SELECT … ; DROP TABLE …`（複文） | `SQL_ERROR` `SQLCODE=-104` | — |

**CALL とデータ域の確認が要点**である。「エラーが返った」ことと「実行されなかった」ことは
別なので、**観測可能な副作用（オブジェクトの実在）を別経路で確かめた**。

→ 実装は `prepare + describe` → `open + describe` → `fetch` の流れで、
   結果セットを持たない文は describe の段階で落ちる。**実行には至らない。**

**根拠 2**: 読み取り範囲は IBM i の権限が決める。`host-lists.ts:4-6` が既に採っている原則
（「見える範囲は IBM i の権限が決めるため、アプリ側で追加の制限は掛けない」）と一貫する。

### D1 に付随する重要な制約（将来この判断を壊しうるもの）

**この決定は「`query` が SELECT しか実行できない」という実装の性質に依存している。**
将来 `query` に更新系を通す改造（`executeImmediate` の追加等）を入れると、
**ブラウザから任意の更新が通るようになる**。そのときは D1 を必ず再検討すること。

依存を明示するため、`query.ts` 側ではなく**この API のコメントに**この条件を書く。

> 断り: 上表は **DDL・CALL・複文について副作用が無いことを確かめた**ものであり、
> 「あらゆる非 SELECT 文が絶対に実行されない」ことの証明ではない。
> 強い経験的根拠として扱い、証明として扱わない。

### D2. 結果セットの上限をサーバー側で強制する

- `maxRows` は既定 200 / 上限 1000。**サーバー側で `z.number().max(1000)` により強制**する
  （UI の出し分けに依存しない＝AGENTS.md §5）。
- **既知の限界を引き継ぐ**: `query` は結果セットを全件取得してから返すため、
  `maxRows` は**応答に載せる行数の上限であって、ホストから取得する行数の上限ではない**
  （前作業 review の [should]）。`SELECT * FROM 巨大表` はホスト側・サーバー側とも重い。
  - **UI で緩和する**: 入力欄の下に「大きな表では `FETCH FIRST n ROWS ONLY` を付けてください」と
    常時表示し、`truncated` のときは結果の上に明示的な警告を出す。
  - 根本解決は backlog（`stream` の早期打ち切りが未検証のため本作業では触らない）。

### D3. CSV はブラウザ側で生成する

**決定**: サーバーに CSV エンドポイントを作らず、取得済みの結果からフロントで組み立てて
`Blob` + `URL.createObjectURL` でダウンロードさせる。

**根拠**: サーバーで作ると「表示用に 1 回・CSV 用にもう 1 回」実行するか、結果をサーバーに
保持するかのどちらかになる。前者は**同じ SQL を 2 回実行**する（4〜7 秒かかるうえ、
2 回目が違う結果を返しうる）。後者はステートレスを崩す。
**画面に出ている表をそのまま落とす**のが、利用者の期待とも一致する。

- 文字コードは **UTF-8 ＋ BOM**、改行は **CRLF**。Excel が UTF-8 CSV を正しく開くのに BOM が要り、
  この PJ は DBCS を含むデータを扱うため（BOM 無しだと日本語が化ける）。
- エスケープは RFC 4180（`"` を `""`、値に `,` `"` 改行を含むならクォート）。
- `null` は空欄、`bigint` は文字列（JSON 応答の時点で文字列化済み）。
- ファイル名は `query-<YYYYMMDD-HHmmss>.csv`。

## 2. サーバー側

### `packages/server/src/host-sql.ts`（新規）

```ts
POST /api/host/sql
  body: { source: { system?, session? }, sql: string, maxRows?: number }
  200:  { columns: ColumnMeta[], rows: Record<string, …>[], rowCount: number, truncated: boolean }
  4xx:  { error: string, code: ErrorCode, sqlCode?: number, sqlState?: string }
```

- `source` は `host-lists.ts` の `sourceSchema` と同形（`.strict()` ＋ どちらか必須）。
  **同じ形を 2 度書かない**——`host-lists.ts` から `sourceSchema` と `resolveSource` /
  `statusOf` / `compact` を切り出して共有する（`host-api.ts`）。
- 接続は `host-connect.ts` の `openDb` を使い、`finally` で閉じる（前作業と同じ単発完結）。
- エラーは `statusOf` で HTTP に写す。**`SqlError` は `sqlCode` / `sqlState` を本文に載せる**
  （SQLCODE を見ないと文法誤りと権限不足が区別できない。前作業 `errorResult` と同じ理由）。
- 認可は `ConfigResolver` に委ねる（一般ユーザーの `srv:` 名指しは `assertAccess` が `FORBIDDEN`）。

## 3. Web UI 側

### 新規タブ種別 `sql:`

タブ ID は `sql:query`、ラベルは「SQL」。触るファイルは既存の追加手順どおり:

| ファイル | 変更 |
|---|---|
| `components/SqlPane.vue` | **新規**。ペイン本体 |
| `paneLabels.ts` | `PANE_LABELS` に `"sql:query": "SQL"` |
| `components/WorkspaceNode.vue` | import ＋ `activeIsSql` ＋ テンプレートの `v-else-if` 分岐 |
| `components/PaneTabs.vue` | `isPane()` に `sql:` を追加（**漏らすと閉じるときに切断処理へ流れる**。過去に `list:*` で実際に起きた） |
| `App.vue` | `activeIsEmulator` の除外に `sql:` を追加（**漏らすと 5250 用トグルが出る**） |
| `components/LauncherPane.vue` | `FEATURES` にエントリ追加（`scoped=true`＝システム紐付け） |

### `SqlPane.vue` の構成

`HostListPane.vue` の作りに合わせる（同じ土俵に乗せ、独自の流儀を持ち込まない）。

- `defineProps<{ tabId: string }>()`
- 取得元は `systemsStore.selected`（ペイン内でシステムを選び直させない）
- `useDelayedLoading()` の `{ visible: slowLoading, busy: loading, run }`
- fetch は `res.ok` / `data.error` 方式、`catch (e)` は `String(e)`
- ルートは `<div class="sql-pane admin">`（AdminPane 系のスタイルに便乗）
- scoped CSS は `--line` / `--muted` / `--accent` / `--mono` のみ使う。
  **未定義変数を書かない**（`var(--border, #444)` の事故がコメントで残っている）

UI 要素:

1. SQL 入力（`<textarea>`。Ctrl+Enter で実行）
2. 実行ボタン（`:disabled="loading || !sql.trim() || !systemsStore.selected"`）
3. 最大行数の入力（既定 200）
4. `FETCH FIRST` の常時ヒント（D2）
5. エラー表示（`SQLCODE` / `SQLSTATE` を併記）
6. 結果テーブル（列名は `columns` の順。`null` は `<span class="null">NULL</span>`）
7. `truncated` のときの警告帯
8. CSV ダウンロードボタン（結果があるときだけ活性）

## 4. 受け入れ基準

- [ ] `sql:query` タブを開いて SQL を実行し、結果が表として出る
- [ ] CSV をダウンロードでき、UTF-8 BOM ＋ CRLF ＋ RFC 4180 エスケープになっている
- [ ] SQL エラーが `SQLCODE` / `SQLSTATE` つきで表示される
- [ ] `maxRows` の上限 1000 が**サーバー側で**強制される（クライアントの改竄で超えられない）
- [ ] `truncated` のとき警告が出る
- [ ] タブを閉じても切断処理が走らない（`isPane` の追加漏れが無い）
- [ ] SQL ペインを開いているとき 5250 用トグル（SO/SI・カナ）が出ない
- [ ] 一般ユーザーが `srv:` を名指しすると `FORBIDDEN`（既存の認可に乗っている）
- [ ] `npm run build -w @as400web/web-ui`（vue-tsc 込み）が通る
- [ ] コンポーネントテスト追加。server 側テストも追加
- [ ] **実ブラウザで確認**（表示・CSV の中身・テーマ追従）
