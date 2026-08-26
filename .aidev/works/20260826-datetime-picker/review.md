# レビュー: EDTMSK 分割欄の日付・時刻ピッカー

## ラウンド 1（2026-08-26T19:20:00Z）

差分: `packages/web-ui/` 6 ファイル（うち新規 4）＋ `scripts/` 2 ファイル。
観点は要件適合 / 価値適合 / 正確性 / 規約適合 / 保守性。

**判定: coding へ差し戻し**（must 2 / should 4 / nit 3）。

### must

- **M1 利用者環境の固有名詞をリポジトリに書いた**（規約適合）
  AGENTS.md「実機の識別子」は**システム名をコードに書かない**（`AS400` 等の当たり障りのない既定に
  しておき、実際の値は環境変数から採る）と定めている。実機のシステム名を 3 か所に書いてしまった:
  - `packages/web-ui/src/composables/dateTimeField.ts:11`
  - `.aidev/works/20260826-datetime-picker/research.md:3`
  - `.aidev/works/20260826-datetime-picker/test-result.md:3`

  版数・CCSID・日本語機といった**特性**は規約の対象外なので残してよい。名前だけを落とす。
  ついでに `.aidev/backlog/input-assist.md` にも同じ記載があり（deliver で書き直す対象）、
  **同じ PR で直す**。

- **M2 ピッカーの初期選択がローカル未送信の編集を無視する**（正確性・価値適合・テストの穴）
  `dateTimeField.ts` の `joinedDigits` は `f.value`（**ホストが送った値**）を直読しており、
  `props.edits` に載った**未送信のローカル編集を見ていない**。`ScreenGrid` は同じ目的に
  `logicalValue(f)`（`edits` → セル → `f.value` の順）を持っており、`optHints` の
  `optSelectedValue` も `inputForSlice(f,0)?.value ?? f.value` で**画面に見えている値**を採っている。

  結果、利用者が `2020/03/07` と打ってからピッカーを開くと、カレンダーは**その月ではなく
  今日の月**で開く。「打ち間違えないように選ばせる」という目的（requirement US1）に直接反する。

  **テストがこれを見逃した**——E2E ⑥ の `check(ym === "2026/08", "欄の現在値を初期選択にする")` は、
  実行日が 2026-08 だったため**今日の月と偶然一致して PASS した**。`f.value` は `000/00/00`
  （解釈不能）で、実際には「今日」にフォールバックしていた。**false-green**。

  対応: `DateTimeTarget` に実効値（`values`）を持たせ、`detectDateTimeFields` に
  `valueOf?: (f: Field) => string`（既定 `f => f.value`）を足して `ScreenGrid` から
  `logicalValue` を渡す。E2E は**今日と重ならない日付**を先に入れてから開く形に直す。

### should

- **S1 `pasteFrom` の JSDoc が 2 つ重なっている**（保守性）
  `ScreenGrid.vue:2822` 付近。元の「画面座標 `start` を起点に流し込む」と、追加した
  「`forceOverwrite` は…」が**連続した 2 つのブロックコメント**になっている。
  AGENTS.md は「関数の責務は JSDoc ヘッダで」としており、ヘッダは 1 つに統合する。

- **S2 EmulatorPane の `Esc` 分岐を既存コメントと本体の間に挿入した**（保守性）
  `EmulatorPane.vue:906` 付近。「Escape・カーソル移動でブロック選択を解除（ACS 相当）」の
  説明コメントの**直後**に別の分岐を差し込んだため、元のコメントが自分の分岐を説明しているように読める。
  追加分は元コメントの**手前**へ移す。

- **S3 ボタンの `aria-label` が常に「日付の選択」**（規約適合・アクセシビリティ）
  `ScreenGrid.vue` の `.dtp-btn` は `MSG_DATE_PICKER` 固定。時刻に確定している欄
  （区切りが `:`）では `MSG_TIME_PICKER` を出す。`dtButtons` に `kind` を持たせれば足りる。

- **S4 `scripts/README.md` が古い**（記録の同期）
  - `:405` `verify-browser-edtmsk-edit.mjs` — 「**14 項目**」のまま。ピッカーの 2 節を足して **29 項目**。
  - `:231` `research-edtmsk.mjs` — 接続先を env 優先に直した旨が無い。
  AGENTS.md「記録の同期（deliver 時）」の趣旨（閉じた事実を同じ PR で台帳へ）に従う。

### nit

- **N1** `ScreenGrid.vue` の `DT_POPOVER_ROWS` が `dtListStyle` の JSDoc と関数の**間**にあり、
  JSDoc が const を説明する形になっている。const を JSDoc の手前へ。
- **N2** `onPickDate` が `dtOpenKey.value = null` を直接触っている。`closeDtPicker()` があるので
  そちらを使う（閉じ方の経路を 1 つにする）。
- **N3** `DateTimePicker.vue` が `parseDate(props.target)` を 2 回呼んでいる（`seedDate` と `selDay`）。
  1 回にまとめる。

### 指摘に至らなかった確認事項（記録）

- **要件適合**: AC1〜AC8 は `test-result.md` のとおり検証済み。AC9 は deliver 工程。
- **`optHints` の 3 点（矩形選択を壊さない）**は単体テストで固定され、実機 E2E ③④⑤ が
  **ピッカーを有効にしたまま**通っている＝既存の編集経路は無傷。
- **core（`@ts5250/tn5250`）に変更なし**——spec の「変更しない」を守っている。
- **`.crt-pop` の括り出し**で `opt-hints-ui.test.ts` 17 件が緑のまま＝既存の意匠は無回帰。
- **秘密の混入なし**（パスワード・鍵・ホスト・ユーザー名は差分に無い。M1 はシステム名のみ）。

## ラウンド 2（2026-08-26T19:50:00Z）

ラウンド 1 の must 2 / should 4 / nit 3 に対する修正と、その過程で生まれた回帰の是正を点検した。

**判定: 通過**（must 0 / should 0 / nit 1）。

### ラウンド 1 の指摘の解消

| ID | 状態 | 確認方法 |
|---|---|---|
| **M1** システム名の記載 | **解消** | `grep -rn SR-OSAKA packages/ scripts/ .aidev/works/` が 0 件。残るのは `.aidev/backlog/input-assist.md` のみ（deliver で書き直す対象・AC9） |
| **M2** 未送信の編集を見ない | **解消** | E2E で `2019/03/07` を打ってから開き、カレンダーが `2019/03` で開くことを実機確認。単体テストも実行日に依存しない年で固定（以前は今日と偶然一致していた） |
| **S1** JSDoc の重複 | 解消 | `pasteFrom` のヘッダを 1 つに統合 |
| **S2** コメントの挿入位置 | 解消 | `Esc` 分岐をブロック選択の説明コメントの手前へ移した |
| **S3** `aria-label` 固定 | 解消 | `dtButtons` に `label` を持たせ、時刻に確定した欄は `MSG_TIME_PICKER`。単体テストで固定 |
| **S4** `scripts/README.md` | 解消 | E2E を **30 項目**へ、`research-edtmsk.mjs` に env 優先の旨を追記 |
| **N1** const の位置 | 解消 | `DT_POPOVER_ROWS` を JSDoc の手前へ |
| **N2** 閉じ方の経路 | 解消 | `onPickDate` は `closeDtPicker()` を通す |
| **N3** `parseDate` の二重呼び出し | 解消 | `currentDate` に 1 回だけ。ついでに**今日にフォールバックした分は選択済みの印を付けない**ようにした（欄を書き換えていないのに選択済みに見えるのを避ける） |

### M2 の修正が生んだ回帰（是正済み・decisions D14）

**判定関数へ実効値（`logicalValue`）を渡した結果、判定の computed が `props.edits` に依存し、
編集のたびに作り直されるようになった。** それを監視して閉じている watch が走り、
**ピッカーが自分の書き込みで閉じる**（時刻の列を 1 つ選ぶと閉じて使えない）。

- **実機 E2E が捕まえた**（時刻タブのクリックが 30 秒タイムアウト）。単体テストは通っていた。
- 是正: 判定は **snapshot だけに依存**させ、実効値は**開いた時点で 1 度だけ捕まえて**
  （`openDtFor` → `dtOpenValues`）ピッカーへ props で渡す。`parseDate(t, values?)` の任意引数。
- 「何が日付欄か」は画面の構造で決まり**欄の値とは無関係**——混ぜたのが誤りだった、という整理も妥当。
- 回帰テストを追加し、**teeth があることを確認済み**（値依存に戻すと落ちる）。

### この工程で確認した観点

- **要件適合**: AC1〜AC8 は `test-result.md` ラウンド 2 のとおり。AC9 は deliver。
- **価値適合**: requirement US1 の「打ち間違えると 1 年ずれる」に対し、
  **打った値からカレンダーが開く**（M2 の是正）ことで初めて成立した。ここは受け入れ基準の
  文面だけでは拾えず、価値の観点で見て初めて見つかった指摘だった。
- **正確性**: 判定の負例 10 件・値の解釈（ゼロ抑制の先頭空白・範囲外・閏年）を単体で固定。
- **規約適合**: 固有名詞なし／メッセージは `opMessages.ts` に集約・です・ます調・句点なし／
  ログ追加なし／`node:*` import なし／`vue-tsc` と `cd packages/web-ui` でのテスト実行を遵守。
- **保守性**: `continuedRunOf` の再実装をしていない（`runsOf` は**画面全体を 1 度走査する**ための
  別関数で、判定条件が同じ点をコメントで明示済み）。`.crt-pop` で意匠を 1 か所に。
- **core 無変更**: `packages/tn5250/` に差分なし（spec の「変更しない」を維持）。
- **秘密の混入なし**: 差分にパスワード・鍵・ホスト・ユーザー名なし。

### nit（差し戻さない）

- **N4** `closeDtPicker` は `dtOpenValues` を空に戻していない。開いている間しか読まないので
  実害は無いが、状態が残る。次に触るときに気付ければ十分。

### walkthrough の要否（autonomous 自律判定）

**実施する。** 差分は 473 行＋新規 4 ファイルで、**判定 → 導線 → 書き込み → core の畳み込み**と
処理が 3 モジュールにまたがる。さらに「なぜこの判定なのか」は**実機実測と 2026-07-30 の
判断の覆り**という文脈を知らないと読めない。人間の PR レビューを助ける価値が高い。
