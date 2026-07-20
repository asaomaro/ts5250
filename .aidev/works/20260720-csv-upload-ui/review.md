# レビュー記録

## ラウンド 1（2026-07-20）

差分 `main...feature/csv-upload-ui`（39 ファイル・+3879/-64）をサブエージェントに委譲してレビューし、
**MUST 3 件・SHOULD 6 件・NIT 8 件・テスト品質 3 件**の指摘を受けた。
一次資料の照合は含まないため委譲した（protocol 2.6）。指摘は主エージェントが実機・ビルドで裏を取った。

### must

- [must] `TransferPane.vue:112` **core ルートを動的 import しており、ブラウザで動かない** / 対応: 修正済
  - `await import("@as400web/core")` が `log.js`(pino) と `transport/`(`node:net`/`node:tls`) を巻き込む。
    **実際に確認した**: `vite build` が
    `Module "node:net" has been externalized for browser compatibility` を出していた。
    ビルドは通るが実行時に落ちる。**テストは vitest が Node で動くため素通りしていた**。
  - 対応: `packages/core/src/browser.ts` を新設し `"./browser"` サブパスを追加。
    純粋な部品（`parseCsv` / 識別子検証）だけを再輸出し、UI は静的 import に変更。
    修正後 `vite build` の node 組み込み externalize は **0 件**。
- [must] `host-upload.ts` **部分書き込みの失敗理由を握りつぶしていた** / 対応: 修正済
  - `writeAll` は `error` を返すのに `UploadOutcome` に載せず、ログにも出していなかった。
    巻き戻せない書き込みで「なぜ止まったか」が誰にも分からない状態だった。
  - 対応: `error` を応答に載せ、部分失敗時は `log.warn` で確定行数・不明範囲・理由を出す。
    画面（部分完了パネル）にも理由を表示。
- [must] `uploadRows` **行数上限が MCP 経路で効いていなかった** / 対応: 修正済
  - 上限は HTTP の zod と `uploadCsv` にあったが、両者が合流する `uploadRows` に無く、
    MCP の `columns+rows` 経路が素通りしていた。`prepareUpload` は全行をメモリ上で符号化するため
    OOM の入口になる。コメントは「サーバー側で強制する」と書いていたのに実態が伴っていなかった。
  - 対応: `uploadRows` の入口で強制。回帰テストを追加。

### should

- [should] `csv-parse.ts` **`""` だけの行が消え、以降の行番号がずれる** / 対応: 修正済
  - `endField()` がフラグを消した後に空行判定していたため、コメントが謳う「`""` は残す」が効いていなかった。
    行単位のフラグ（`rowHadQuote`）に変更。
- [should] `csv-parse.ts` **`"ab"cd` を黙って `abcd` として受けていた** / 対応: 修正済
  - `ab"cd` は拒否するのに逆向きは素通り。「黙って解釈を決めない」が片側にしか効いていなかった。
    閉じ引用符の直後は区切りか改行のみ許す。
- [should] `csv-parse.ts` **エラーの行番号が利用者の見る行と違う** / 対応: 修正済
  - `records.length + 1`（ヘッダー込み・空行スキップ後）で数えていた。物理行を数える方式に変更。
    「パーサーが 2 つあると行番号がずれる」を避けるために core に置いたのに、
    パーサー内部で 2 つの数え方が並立していた。
- [should] `host-upload.ts` **`close` の例外が部分成功の報告を消す** / 対応: 修正済
  - `writeAll` は失敗しても値を返すため、その後の `close` が壊れた接続で投げると報告ごと失われる。
    `close` を `try/catch` で包み、結果を先に確定させる。
- [should] 識別子の正規表現が **UI と core で二重化**（コメントは「二重に持たない」と主張） / 対応: 修正済
  - `column-meta.ts` は `DbConnection` 経由で Node 依存を引き込むため UI から使えず、
    結果として複製されていた。`identifier.ts`（純粋）に実体を移し、両者がそれを使う。
- [should] `TransferPane.vue` **最初のバッチで失敗すると「1 〜 0 行目は書き込まれました」** / 対応: 修正済
  - 0 件のときは「確実に書き込まれた行はありません」と出す。

### nit

- [nit] `upload-prepare.ts` ちょうど上限件数で `truncated` が立つ / 対応: 修正済（未処理行が残るときだけ立てる）
- [nit] `upload-prepare.ts` 成功経路で CHAR を 2 回符号化 / 対応: 修正済（1 回に）
- [nit] `TransferPane.vue` 方向切替で取得側の結果が残る / 対応: 修正済
- [nit] `TransferPane.vue` 取得モードでもファイルドロップを受ける / 対応: 修正済
- [nit] `ddm-connection.ts` JSDoc が別の型に付いてしまっている / 対応: **見送り**（次 work で DDM 経路を置き換えるため）
- [nit] `host-upload.ts` `csv.length` は UTF-16 単位でバイトではない / 対応: **見送り**（同上。上限は安全側に働く）
- [nit] `member` / `recordFormat` が未正規化 / 対応: **見送り**（同上）
- [nit] `tabId` prop 未使用 / 対応: 見送り（`SqlPane` と同じ既存の慣習）

### テスト品質（**素通りしていた 3 件**）

- [must] `csv-parse.test.ts` 「引用符付きの空文字は残す」が 2 列のケースで書かれており、
  **壊れている振る舞いを検証していなかった** / 対応: 1 列のケースを追加し、修正を実証
- [should] `host-upload.test.ts` `not.toBe(422)` は常に真 / 対応: 実際の応答コードを検証する形に変更
- [should] `host-upload.test.ts` 「上限ちょうど」が上限超過と区別できていなかった
  （どちらも `CONFIG_ERROR`）/ 対応: メッセージで区別する形に変更

### 指摘なしと確認された観点

資源の後始末（両接続とも全経路で閉じる）・SQL インジェクション・ログへの秘密混入・
認可（`resolveSource` に委譲）・`console.*` の不使用・未使用エクスポート。

### 所見

**最も重い指摘（must 1）は、テストが通っていたのに実ブラウザでは動かない類のもの**だった。
`test-result.md` に「実ブラウザ未確認」と書いていた項目が、そのまま実害として現れている。
jsdom のコンポーネントテストは DOM 構造とロジックしか固定しないという限界が具体的に露呈した。

## 検証（修正後）

| | 件数 |
|---|---|
| core | 612 ✅ |
| server | 319 ✅ |
| web-ui | 449 ✅ |

`npm run build`（`vue-tsc` 込み）・`npm run lint` 通過。
`vite build` の node 組み込み externalize **0 件**（修正前は 6 件）。
