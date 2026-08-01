# レビュー記録

## ラウンド 1（2026-08-01）

差分 **71 ファイル**（M 68 / A 2 / D 1）。うち 58 ファイルは import 指定子の付け替えで、
実質の読みどころは新設ガード 2 本と core の `index.ts` の削除。

> **D 1 件は削除ではなく作り直し**——`hostserver-reexport.test.ts` を
> `hostserver-not-reexported.test.ts` に改名し、中身を反転させた。
> 内容が全面的に変わったので git が rename として検出していない（`git log --follow` は繋がらない）。

### 要件・仕様との突き合わせ

`spec.md`「5.」の受け入れ基準 12 項目すべて充足（`test.md`）。**must は 0 件**。

主目的の `packages/core/dist/index.js` の `@as400web/hostserver` は **33 → 0**。

### 指摘（review 内で修正済み。差し戻しはしていない）

- **[should] `packages/server` の 4 ファイルが、サーバー自前の pino ではなく
  ライブラリ側の注入式ロガーを使っていた**（`db-pool.ts` / `host-sql.ts` /
  `result-set-store.ts` / `host-upload.ts`）。

  **これは本作業が作ったものではなく、既存のバグ**である。分割前は
  `import { childLog } from "@as400web/core"` と書かれており、**core が base の `childLog` を
  再輸出していたため注入式ロガーだと気づきにくかった**。import 元を実体に合わせた結果、
  `@as400web/base` から取っていることが露わになった。

  AGENTS.md は明示している——「アプリ（server）は自前の pino を使う。監査証跡が
  『注入し忘れ』で静かに消えないよう、**消えて困る側を注入に依存させない**」。
  `main.ts` が `setLogSink` を呼ぶので通常の起動では出力されるが、**それは「注入に依存している」
  ということ**で、このモジュール群が避けたかった形そのもの。呼ばない入口
  （テスト・ツール・組み込み利用）では静かに消える。

  **対応: 修正済**（4 ファイルとも `./log.js` へ）。requirement は「振る舞いは一切変わらない
  （import 元の付け替えのみ）」としていたが、**規約に明確に反する既存の欠陥で、かつ
  いま触っている行そのもの**だったため、報告だけして残すより直すのが正しいと判断した。
  修正で出力が減ることはない（`setLogSink` 未呼び出しの経路では**増える**）。

- **[should] `log-independence.test.ts` が「どちらを import しているか」を見ていなかった。**
  既存の 2 件は「server の `log.ts` が pino である」ことしか検査しておらず、
  **各ファイルがどちらを使っているかは無検査**だった。だから上の 4 ファイルが素通りしていた。
  **対応: 走査テストを 1 件追加**（`src` を再帰し、`childLog` を `@as400web/*` から
  取っている箇所を 0 件に固定）。追加した直後に **`db-pool.ts` を検出した**——
  こちらが `grep` で数えたときに取りこぼしていた 4 件目である（下記）。

### 設計面で確認したこと（指摘なし）

- **実行時の辺が実際に消えた**。`dist/index.js` の `@as400web/hostserver` が 33 → 0。
  `dist/browser.js` も 0（型のみ再輸出が値に化けていない）。
- **web-ui は 1 行も変わっていない**。バンドルは 359,853 バイトで前後一致。
- **名前を落としていない**。書き換え前後で「各ファイルが `@as400web/*` から取っている
  ローカル名の集合」を突き合わせ、78 ファイル分すべて差分ゼロ。別名（`childLog as coreChildLog`）と
  `type` 修飾も保たれている。
- **ガード 2 本とも、わざと壊して落ちることを確認済み**（`test.md`「5.」）。
  再輸出を 1 行戻したとき **`tsc -b` は通った**——型検査では捕まらないことの実証。
- **`export *` を使っていない**。core・hostserver とも公開面は列挙のまま。

### 残す判断（対応しない）

- **`tools/hostserver-check` の 7 ファイルが旧名 `Tn5250Error` を使っている**（decisions.md D4）。
  `@as400web/base` の JSDoc は「新しいコードでは `As400Error` を使う」としているが、
  これは新しいコードではない。本作業は import 元の付け替えに徹し識別子には触れていない。
  **follow-up として backlog に起票する。**
- **`packages/core` の `dependencies` に `@as400web/hostserver` が残る**（decisions.md D5）。
  `browser.ts` の型 3 箇所が参照するため。完全に外すには web-ui を触る必要があり、
  requirement で対象外にしている。**follow-up 3c として起票する。**
- **同一パッケージからの import 文が 1 ファイルに 2 つ並ぶ箇所がある**
  （`host-dtaq.ts` の `@as400web/hostserver` 2 文）。元の import 文が 2 つあり、
  それぞれを宛先ごとに割った結果。まとめてもよいが、**元の文と割った文の対応が
  1 対 1 で読める**利点を優先した。lint も通っている。

### この作業で 2 度踏んだ落とし穴（retro 向け）

**行ベースの `grep` を信じたせいで、同じ取りこぼしを 2 回した。**

1. plan では「分類走査で移し残しを 0 にしてから撤去する」としたが、走査が
   `import { … } from "@as400web/core"` の**名前**しか見ておらず、
   `vi.spyOn(await import("@as400web/core"), …)` と core 自身のテストを取りこぼした
   （decisions.md D7）。→ 撤去後にテスト 6 件が落ちて発覚
2. ロガーの調査で `grep -rn "childLog" … | grep import` を使い、**複数行の import 文**に
   書かれた `db-pool.ts` を落とした（さらにこの環境の `grep` が当該ファイルで
   無出力を返す挙動も重なった）。→ Node で書いた走査テストが検出

いずれも **Node で書いた走査（テスト）が正解を出し、シェルの grep が誤った**。
一次情報として `grep` の結果を報告する前に、走査で裏を取ること。

### 集計

| 重大度 | 件数 |
|---|---|
| must | 0 |
| should | 2（いずれも修正済み） |
| nit | 0 |

修正後に `npm run build` / `npx eslint packages tools` / 全 8 パッケージのテストを再実行し、
すべて緑（合計 **269 files / 3,266 tests**、失敗 0、skip は `zip-writer` の 4 件のみ）。
