# レビュー記録

## ラウンド 1（2026-07-20）

**判定: 差し戻し（must 0 / should 4 / nit 6）**

差分は要件・仕様に整合し、MCP の非退行と `spoolCcsid` の 5 箇所貫通は**検証のうえ問題なし**と確認できた。
一方、UI に競合状態が 2 件、列幅の配線漏れ、core の余分な export が残っていた。

### must（0 件）

なし。打ち切りロジック（`host-spools.ts:74-76`）は全境界で正しく、
`assertMax` が `openCommand` より先に走るため失敗経路の接続リークも無い。

### should

- **[should] `packages/web-ui/src/components/SpoolPane.vue:156-177` — 古い応答が新しい表示を上書きする**
  `select()` に順序制御が無く、行 A → 行 B と続けて押すと、**先に解決した方が `pages` を取る**。
  中身取得は毎回ネットワーク印刷サーバーへ新規接続する（秒単位）ため順序逆転は現実的。
  結果、見出しとファイル名は B なのに本文は A という表示になり、**エラーも出ない**。
  帳票ビューアで「別のスプールの中身を、このファイル名のものとして見せる」のは実害がある。
  さらに `useDelayedLoading` を 1 つしか持たないため、先の完了で `busy=false` になり
  **後続の取得中に PDF ボタンが押せる**。
  対応: 単調増加トークンを取り、応答時に最新でなければ捨てる。

- **[should] `SpoolPane.vue:227-237` vs `:112-143` — システム切替でも同じ競合**
  watcher が `rows` を捨てても、進行中の `load()` が**後から旧システムの行を書き戻す**。
  利用者がその行を押すと、**新システムに旧システムの id を送る**ことになる。
  `HostListPane.vue:139-146` は同じ危険をコメントで警告しているが、実際には防げていない。
  既存テストが通るのは、切替前に fetch が解決しているため。

- **[should] `SpoolPane.vue:290` — 列幅リサイズが半分しか配線されていない**
  `widthStyle(ci)` を `<th>` にしか当てておらず、`<td>` に当てていない。
  一方 `th, td { max-width: 40ch }`（`:366`）は両方に効く。
  `useColumnWidths.ts:42-44` が**まさにこの落とし穴を明記**している——
  「width だけでは… **max-width も動かさないと打ち切りが既定のままで、広げても隠れた文字が見えない**」。
  既存の 2 利用者（`SqlPane.vue:462,483` / `TransferPane.vue:327,346`）は両方に当てている。
  合わせて、省略された値を読むための `:title` も欠けている。

- **[should] `packages/core/src/index.ts:154` — 撤回した方針5 の残骸**
  `ListSpoolOptions` の export を追加したが、`packages/**` のどこからも import していない。
  これは `SpoolListResult` を返すシグネチャ変更のために足したもので、
  その変更は D4 で撤回済み。**core の公開 API を理由なく広げている**。

### nit

- **[nit] `packages/server/src/host-spools.ts:102-104` — `assertMax` の理由が事実に反する**
  「MCP ツールは zod スキーマを通らずにこの関数を直接呼ぶため」と書いたが、**誤り**。
  `registerTool` は `inputSchema` を `safeParseAsync` で検証しており
  （`@modelcontextprotocol/sdk` の `mcp.js:174` / `:430`）、`host_list_spools` は
  `MAX_LIMIT` で頭打ちしてから `listSpools` に来る。
  検査自体は残す価値がある（export された関数はどこからでも呼べる）が、
  **理由を正しく書き直す**。`host-upload.ts` の文言を根拠ごと写して確かめなかったのが原因。
  ※ `host-upload.ts:96-98` の同じ主張も怪しいが、そちらは本作業のスコープ外（別課題候補）。

- **[nit] `SpoolPane.vue:139-141` — 通信失敗時に前の行が残る**
  `!res.ok` の分岐は `rows` を捨てるが、`catch` は捨てない。
  fetch が throw するとエラー帯の下に**前システムの行が残る**。

- **[nit] `SpoolPane.vue` — 行がキーボード操作できない**
  `@click` のみで `tabindex` / `role` / キーハンドラが無い（UI-DESIGN アクセシビリティ）。
  既存ペインの表は行クリック自体が無いため、**この作業で新しく持ち込んだ操作**である。

- **[nit] `SpoolPane.vue:426` — 生の色コード `#c62828`**
  UI-DESIGN は生色を避けよと定める。ただし `HostListPane` / `SqlPane` / `TransferPane` /
  `AdminPane` の `.error` がすべて同じ値で、**リポジトリ全体の既存の逸脱**。
  本 PR で単独に直すと不揃いになるため、変数化は別課題とする。

- **[nit] `packages/server/test/host-spools.test.ts:195` — モックを片方しか復元していない**
  `openCommand` の spy が復元されず、`listWith` を呼ぶたびに積み上がる。
  今は後続ブロックが接続に触れないので無害だが、**テストの順序が意味を持ってしまう**。

- **[nit] `host-spools.ts:179-182 / :199-202 / :227-230` — 同じ catch が 3 回**
  `host-api.ts` が「同じ形を 3 度書かない」を理由に切り出された経緯がある。
  ただし `host-lists.ts` も 2 回繰り返しており、今回だけ抽象化すると不揃いになるため見送る。

### 検証して問題なしと確認した項目

- **MCP 非退行**: `host_list_spools` の既定は `100`（`DEFAULT_SPOOLS` と同値）、出力は `{ items, count }` のまま、
  `truncated` は漏れていない。`host_get_spool` の `text` は
  `readSpooledText` の実装（`netprint-connection.ts:255-258`）と**同一の flatten**。
  ccsid のフォールバックも `spoolCcsid` 未設定時は従来と等価。
- **`spoolCcsid` の貫通（AGENTS.md §6）**: 信頼設定ではない（コードページ番号のみ）と正しく分類。
  `config-types.ts:51,159` / `config-routes.ts:75`（POST・PUT 両方が通る）/ `config-store.ts:147` /
  `config-resolver.ts:128-130`（システムのみ・`ccsid` からの混入なし）/ web-ui 側まで**転記漏れなし**。
  ※ spec が「`config-store.ts` の `:146` / `:163` の 2 箇所」と書いていたのは**数え過ぎ**——
  システムの公開形は `publicSystem()` の 1 箇所のみ（`:163` はセッション用）。
- **UI-DESIGN 準拠**: ペイン根の非スクロール、sticky `th` の背景 `--card`、
  罫線の `box-shadow` 化はいずれも規約どおり。
- **テストの実質性**: `vi.spyOn` は空振りしていない——`openCommand` のモックは `.call` を持たないため、
  spy が効いていなければ 4 件とも `TypeError` で落ちる。`+1` を忘れた実装なら
  `listWith(11, 10)` が 10 件を返し `truncated` の表明で落ちる。境界テストとして機能している。

---

## ラウンド 2（2026-07-20）

**判定: 通過（must 0 / should 0 / nit 3 — いずれも意図的に見送り）**

ラウンド 1 の should 4 件と、nit のうち 3 件（理由の誤り・catch の行残り・キーボード操作）を修正した。

| 指摘 | 対応 |
|---|---|
| 古い応答の上書き（select） | 修正: 単調増加トークン `contentSeq` で最新以外を捨てる |
| システム切替の競合（load） | 修正: `listSeq` を同様に適用し、**watcher でも番号を進める**（進めないと進行中の応答が書き戻す） |
| 列幅リサイズの配線漏れ | 修正: `<td>` にも `widthStyle(ci)` と `:title` を当てた |
| `ListSpoolOptions` の余分な export | 修正: 撤回した |
| `assertMax` の理由が事実に反する | 修正: 実際の理由（export された関数はどこからでも呼べる）に書き直した |
| 通信失敗時に前の行が残る | 修正: `catch` でも `rows` を捨てる |
| 行がキーボード操作できない | 修正: `tabindex` / `role="button"` / Enter・Space ハンドラを追加 |
| モックの片側復元（テスト） | 修正: `afterEach` で `restoreAllMocks` |

見送った nit（理由つき）:

- **生の色コード `#c62828`**: リポジトリ全体の既存の逸脱で、本 PR だけ直すと不揃いになる。別課題。
- **catch の 3 回重複**: `host-lists.ts` も繰り返しており、今回だけ抽象化すると不揃いになる。
- **`host-upload.ts:96-98` の同種の誤った理由**: 本作業のスコープ外。別課題。

### 追加した回帰テスト

競合状態の回帰テストを 3 件追加した（応答の逆順到着 / 切替中の書き戻し / 通信失敗時の行破棄）。

**空振りしないことを確認済み**——ガードを一時的に外して再実行し、
逆順到着と切替中の書き戻しの 2 件が**実際に失敗する**ことを確かめた。
`total` の件で「実機では起こらない状態を前提にしたテストが緑になる」失敗をしているため、
新しい回帰テストは必ずこの確認を通す。

### flaky を 1 件潰した

全体実行で「PDF の失敗を黙らせない」が 1 度だけ落ちた（単独実行では常に成功）。
機序は **disabled のボタンに `trigger("click")` してもハンドラが走らず、
テストが「何も起きなかった」まま素通りする**こと。
`clickPdf()` ヘルパーを設け、**押せる状態であることを先に表明**するようにした。
以後 6 回連続で 475 件緑。低頻度でも「静かな空振り」を残さない。

### core 変更の縮小

`SpoolListResult` の撤回と `ListSpoolOptions` export の削除により、
`packages/core/src/index.ts` は**差分ゼロ**、`spool-list.ts` は**コメントのみ**になった。
core の実質的な変更は `ConnectOptions.spoolCcsid`（decisions D1）だけで、
requirement の「core 無改修」の趣旨にほぼ戻っている。
