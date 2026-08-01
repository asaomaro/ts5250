# レビュー記録

## ラウンド 1（2026-08-01T09:33:13Z）

差分 5 ファイルを requirement / spec / AGENTS.md の観点で点検した。

### 確認して問題なしだったもの

- **`escapeField` の再帰が正しい**: 印を付けた `text`（文字列）で再帰すると、
  `null`/`undefined` でも `isLob` でもないので `String(value)` ＋ RFC 4180 のクォート判定に落ちる。
  無限再帰にはならない。`x,y…（以降省略）` が 1 フィールドとして囲まれることをテストで固定済み
- **`import type` が実行時に漏れていない**: `@as400web/hostserver` は web-ui の
  **devDependencies のまま**（`package.json` は無変更）。`vue-tsc` と `tsc -b` が両方通り、
  `import type` は実行時コードを出さない
- **`SqlPane.vue` の `Row` 変更に実行時の影響が無い**: 行は `data.rows ?? []`
  （fetch 応答）から来る型注釈だけの経路（292 / 377 行）。値の作り方は変わらない
- **画面の表示を変えていない**: `sql-pane.test.ts` 45 件を**1 件も変更せず**通した
- **`String(v ?? "")` のフォールバックが妥当**: `false` → `"false"`、`0` → `"0"`、
  `null` → `""`。テンプレートは `isLob` の分岐内でしか呼ばないので実際には到達しない
- **`isLob` 内の `as` を残した判断が正しい**（decisions D3）。型ガード自身が `unknown` から
  判別子を読む実装であり、requirement が問題にした「絞った後に読み直す」とは別物
- **`vue-tsc` の基準線を取った**——`git stash` して回すと exit 0。出た 2 種類のエラーは
  本変更が持ち込んだもので、既存の未修正を巻き取ったわけではない（test-result.md）

### 指摘

- [nit] `packages/web-ui/src/csv.ts:36-38` — バイナリ LOB が `(LOB)` になり
  **取得成功と未取得の区別が付かない**件。⚠ コメントで所在は明示したが、直していない。
  `failed` と同じ種類の欠陥ではあるものの、requirement のスコープ外であり、
  backlog に「BLOB（バイナリ）と中身のある DBCLOB での検証」が**別項目として残っている**
  ——実物を見てから決める方が確か（decisions D4）。
  / 対応: **許容（follow-up）**

- [nit] `SqlResultTable.vue` の `Cell` と `SqlPane.vue` の `Row` に**同じ union が 2 か所**
  残っている（`string | number | boolean | null | LobPlaceholder`）。今回 LOB 部分は
  実体に寄せたので**もう食い違わない**が、共有型に括る余地はある。
  ただし括ると片方のコンポーネントがもう片方に依存するか、新しい型ファイルが要る。
  差分の焦点を保つため見送る。
  / 対応: 許容

### 判定

**must 0 / should 0 / nit 2** → **通過**（次工程: deliver）。

nit 2 件はいずれも「今回作り込んだ欠陥」ではなく、直すとスコープが広がるもの。
PR の follow-up に書いて残す。
