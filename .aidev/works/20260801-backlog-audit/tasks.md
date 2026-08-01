# タスク: backlog の完了済み項目を消し込み、deliver 時の同期を規約にする

- [x] T1: `.aidev/backlog/library-extraction.md:61` の「CCSID テーブルの同梱単位を見直す」を閉じる。
      完了注記（`20260726-ccsid-table-bundling` / PR #171 / 1,407,469 → 358,354 バイト）を**先頭の子項目**に置き、
      `（作業自体は未着手）` と 2026-07-27 追記の古い実測値・古い到達経路に取り消し線を引く。
      原因分析（`:62-73`）と調査手法（worktree 比較）は残す
- [x] T2: `.aidev/backlog/datastream-commands.md:83` の「SAVE PARTIAL SCREEN のパラメータ 5 バイトの意味」を閉じる。
      同ファイル `:49` の `- [x]` を指し、解消済みの ⚠（読み飛ばし長 5 の依存）に取り消し線を引いて
      `wtd-applier.ts:143-152` を根拠に添える
- [x] T3: `.aidev/backlog/hostserver.md` の 4 件を閉じる（依存: なし）
      — `:38` MCP 公開（PR #93 / #104）／`:39` Web UI（PR #94 / #104）／
      `:208` README（`README.md:162-164`）／`:264` LAN 接続時間（PR #219・177ms）。
      `:39` の `DECIMAL(5,0)` の落とし穴と `:264` の動機 2 行は残す
- [x] T4: `.aidev/backlog/hostserver.md` の 2 件を割る（依存: T3）
      — `:48` DES 経路（実装は PR #109 で完了 → 実機確認を `[ ]` で残す）／
      `:172` PUB400 以外での検証（実機で完了 → 7.5 以外のバージョンを `[ ]` で残す）。
      `[x]` と `[ ]` を**兄弟**（行頭 `- `）で並べる
- [x] T5: `.aidev/backlog/hostserver.md:283-284` の誤帰属を直す（依存: T4）
      — `MCH0802` の子項目を `:268`（`host_call_program`）へ**逐語のまま移す**。
      ロケーター側には `20260720-sql-lob-locator/research.md` F5 を根拠にした注記を置く。
      **スコープの逸脱（decisions D-C）。単独で revert できるよう他の変更と行を重ねない**
- [x] T6: `AGENTS.md` の `## 残課題（retro → issue 候補）` の**直前**に `## 記録の同期（deliver 時）` を足す。
      根拠の 3 点セット・取り消し線・部分完了は兄弟で割る、の 3 規約と、
      2026-08-01 に実際に起きた実例を書く。資格情報はプレースホルダのまま
- [x] T7: 検算（依存: T1〜T6）
      — `grep -c '^- \[ \]' .aidev/backlog/*.md` が 5/0/19/0/2/8/0/1（合計 **35**）／
      `aidev status` の BACKLOG と一致／`git diff --stat` に `packages/`・`tools/` が出ない／
      `git diff` を読んで未着手項目に触れていないこと／注記に書いたファイル:行が実在すること

## T7 の検算結果（2026-08-01）

| 検算 | 結果 |
|---|---|
| 未チェック件数（`grep -c '^- \[ \]'`） | 5 / 0 / **19** / 0 / **2** / 8 / 0 / 1 = **35** ✓ |
| `aidev status` の BACKLOG | 「未着手 **35** 件」で grep と一致 ✓ |
| 割った 2 件が集計に残る | `hostserver.md:66`（実機認証）・`:195`（7.5 以外）とも `^- \[ \]` にヒット ✓ |
| `git diff --stat` | 4 ファイル（backlog×3 ＋ AGENTS.md）。`packages/`・`tools/` はゼロ ✓ |
| 未着手項目への波及 | 意図した 9 箇所（閉じる 6・割る 2・移す 1）のみ。`IFS の zip 上限「値」を UI に表示` 等は context のまま ✓ |
| 参照先の実在 | `README.md:162-164` / `katakana.ts` / `katakana-no-dbcs.test.ts` / `TransferPane.vue` / `des.ts` / `wtd-applier.ts:143` / `host-server-tools.ts` / `signon.ts:222` / `server-connect.ts:156` すべて実在 ✓ |

## review ラウンド 1 の差し戻し対応（2026-08-01）

事実誤りが 2 件見つかり、coding を再開して直した（`review.md` ラウンド 1）。

- [x] R1: `library-extraction.md` の「この **1 関数**を取る」→ **`katakanaChar` / `latinChar` の 2 関数**。
      併せて 2 関数と 2 表の 1 対 1 対応（`katakanaChar`＝930 SBCS 部／`latinChar`＝939 SBCS 部）を明記
- [x] R2: `hostserver.md:38` の PR #93 の一覧から **`host_dtaq_*` を外す**。
      DTAQ は 20260720-dtaq-server（PR #108）由来なので `host_upload_table`（PR #104）と並べて書き分けた

再検証: 未チェック件数は **35** のまま。`git diff --stat` は `.md` 4 ファイルのみ。
新しく書いた根拠も照合済み（`ScreenGrid.vue:66-67` / `katakana.ts:32,41` / PR #108 = `feature/dtaq-server`）。
