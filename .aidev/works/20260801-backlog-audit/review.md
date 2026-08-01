# レビュー記録

## ラウンド 1（2026-08-01T03:29:01Z）

差分は `.md` 4 ファイル（backlog×3 ＋ `AGENTS.md`）。コード変更なし。

本作業の目的は「**台帳を正しくする**」ことなので、レビューの重心は文言ではなく
**書き加えた根拠が事実として正しいか**に置いた。注記に出てくる PR 番号・works slug・
ファイル:行・関数名・数値を、リポジトリの現物に 1 つずつ当てた。

原典照合はサブエージェントに委譲せず、主エージェントが直読した（protocol.md「2.6」）。

### 指摘

- **[should]** `.aidev/backlog/library-extraction.md` — 「web-ui は `@as400web/core/browser` から
  **この 1 関数**を取る」が**事実と違う**。実際は **`katakanaChar` と `latinChar` の 2 関数**
  （`packages/web-ui/src/components/ScreenGrid.vue:66-67`）。
  すぐ下に「**SBCS 部が 2 つ残るのは正しい**」と書いているのに入口を 1 関数と書くと、
  「1 関数のために表が 2 つ？」という矛盾した読み方を招く。実際は
  `katakanaChar`（930 の SBCS 部）と `latinChar`（939 の SBCS 部）が**1 対 1 で表に対応**しており、
  2 関数・2 表と書けば筋が通る。
  なお元の backlog（2026-07-27 追記）の「1 関数だけ」は**着手前の記述としては正しかった**——
  `latinChar` は修正の一部として後から足されている（`katakana.ts` の JSDoc: 930 の表しか持たないと
  930 のセッションで切替が無反応になる、という利用者報告が根拠）／ 対応: 差し戻し

- **[should]** `.aidev/backlog/hostserver.md:38`「MCP ツールとして公開」 — 「20260719-hostserver-mcp-tools
  （PR #93）で公開」の直後に並べたツール一覧に **`host_dtaq_*` が混ざっている**。
  DTAQ 系は PR #93 ではなく **PR #108（`feature/dtaq-server`）**で入った（初出コミット `7047d1d`。
  `git log -S'"host_dtaq_send"' -- packages/server/src/host-server-tools.ts` で確認）。
  `host_upload_table` は別出典として書き分けているのに DTAQ だけ紛れているのは一貫していない。
  **由来の取り違えは、この作業がまさに潰そうとしている種類の誤り**なので看過できない／ 対応: 差し戻し

- **[nit]** `hostserver.md`「Web UI から操作」 — 新しく足した `→` 注記
  （「ダウンロードは PR #94、アップロードは PR #104」）と、その下に残した既存の子項目
  「**ダウンロード側は 2026-07-19 完了**（`20260719-hostserver-web-ui`。SQL ペイン＋CSV）」が
  **同じことを 2 度書いている**。ただし既存記述は経緯として残す方針（spec D4）を採っており、
  消すと「いつ何が分かっていたか」が失われる。**許容する**／ 対応: 許容

- **[nit]** `datastream-commands.md` の「SAVE PARTIAL SCREEN のパラメータ 5 バイトの意味」は
  同ファイル `:49` の重複なので、本来は 2 つを 1 つに統合したい。
  requirement が「削除はしない」をスコープ外に挙げているため、**`[x]` にして重複である旨を
  明記するに留めた**。統合は別途／ 対応: 許容

### 確認して**問題なかった**もの（当てた根拠）

| 記述 | 照合先 | 結果 |
|---|---|---|
| `host-server-tools.ts` の 7 ツールが PR #93 由来 | `git log -S` で全て `28195d9` → PR #93 | ✅ |
| `host_upload_table` が PR #104 由来 | `b85d62d` → `Merge pull request #104` | ✅ |
| `des.ts` が 167 行 | `wc -l` = 167 | ✅ |
| `signon.ts:222` / `server-connect.ts:156` の分岐 | 両方とも該当行に `passwordSubstituteDes` | ✅ |
| `des.test.ts` / `hostserver-password.test.ts` の実在 | `packages/core/test/` に両方あり | ✅ |
| 805/805 バイト一致 | PR #109 本文 | ✅ |
| README の CLI 引数が PR #199 由来 | `git log -L162,164:README.md` → `a2ce726 (#199)` | ✅ |
| SAVE PARTIAL SCREEN が PR #223 由来 | `gh pr list` で `tn5250-cross-check` → #223 | ✅ |
| バンドル 1,407,469 → 358,354 バイト | 2026-08-01 に `npm run build -w @as400web/web-ui` で実測 | ✅ |
| 表の識別子が SBCS 部 2 つだけ | バンドルを grep。DBCS 部・1399・37・273 は 0 件 | ✅ |
| `katakana-no-dbcs.test.ts` が 4 ファイルに固定 | テスト本文の `toEqual([...])` が 4 要素 | ✅ |
| 177ms / 117ms | `20260730-sql-fetch-limit/test-result.md:22,24` | ✅ |
| 201 往復 / 1,191,336 バイト / 2,072ms | 同 research.md:42 | ✅ |
| `MCH0802` が `host_call_program` の結果 | `20260719-hostserver-mcp-tools/test-result.md:49` | ✅ |
| PR #171 が 5 日前 | マージ 2026-07-27、本日 2026-08-01 | ✅ |
| 割った 2 件が `^- \[ \]` に掛かる | `grep -n` で `:66` `:195` を確認 | ✅ |

### 規約適合

- **`AGENTS.md` セキュリティ**: 追記した検証手順は `AS400_USER=xxx AS400_PASSWORD=yyy` の
  プレースホルダのみ。実資格情報なし ✅
- **`AGENTS.md` の文体**（理由を必ず添える）: 新設節の 3 規約すべてに理由を書いた
  （「PR 番号だけだと後から辿るのに GitHub が要る」「インデントした子は件数に入らない」）✅
- **backlog の文体**（断定と留保の書き分け）: 実測したものだけ「実測」と書いた。
  DES は「実装済み」と書き、実機確認は別項目として `[ ]` に残した ✅
- **書式のファイル内一貫性**（spec D1）: `hostserver.md` は `→`、`library-extraction.md` /
  `datastream-commands.md` は `- **完了**` 子項目。既存の隣接項目と揃っている ✅

### スコープ

- `decisions.md` D-C の逸脱（誤帰属の移動）は**宣言どおり 1 箇所のみ**で、
  他の変更と行が重ならない＝単独 revert 可能 ✅
- 未着手項目への意図しない波及なし。変更 hunk 15 箇所すべて意図した位置 ✅

**判定: must 0 / should 2 / nit 2 → coding へ差し戻し。**

---

## ラウンド 2（2026-08-01T03:34:00Z）

ラウンド 1 の should 2 件の対応を確認した。

### 対応の確認

- **[should]** `library-extraction.md` の「1 関数」 → **`katakanaChar` / `latinChar` の 2 関数**に修正。
  併せて **どちらがどの表に対応するか**（`katakanaChar`＝930 の SBCS 部＝CP290 /
  `latinChar`＝939 の SBCS 部＝CP1027）を書き、「2 関数・2 表」の対応が読めるようにした／ **修正済**
- **[should]** `hostserver.md:38` の `host_dtaq_*` → **PR #93 の一覧から外し**、
  `host_upload_table`（PR #104）と並べて **PR #108 由来として書き分けた**／ **修正済**
- **[nit]** 「Web UI から操作」の重複 → 経緯を残す方針どおり**維持**（許容）
- **[nit]** SAVE PARTIAL SCREEN の重複項目 → 削除はスコープ外につき**維持**（許容）

### 再検証

- 未チェック件数: **35**（`grep -c '^- \[ \]'` / `aidev status` とも一致。修正で動いていない）
- `git diff --stat`: `.md` 4 ファイルのみ。`packages/`・`tools/` はゼロ
- 修正で新たに書いた根拠の照合:
  - `ScreenGrid.vue:66-67` に `katakanaChar,` `latinChar` が並ぶ ✅
  - `katakana.ts` の `katakanaChar` が `ibm930Sbcs`、`latinChar` が `ibm939Sbcs` を参照 ✅
  - `host_dtaq_send` の初出が `7047d1d` → `Merge pull request #108` ✅

**判定: must 0 / should 0 / nit 2（いずれも許容）。review 通過。**
