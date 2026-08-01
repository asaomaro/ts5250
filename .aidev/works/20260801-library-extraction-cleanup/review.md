# レビュー記録

## ラウンド 1（2026-08-01）

差分 **43 ファイル（すべて M）**。うち 32 ファイルは `Tn5250Error` → `As400Error` の
単一識別子の置換で、実質の読みどころは **6 ファイル**。

| 内訳 | ファイル |
|---|---|
| 3d の識別子置換 | 32（hostserver/test 20・tools 8・core/test 4） |
| 3c の実体 | 6（`browser.ts` / web-ui 4 / core の manifest 2） |
| ガード強化 | 1（`hostserver-not-reexported.test.ts`） |
| 規約の追随 | 1（`AGENTS.md`） |
| ロックファイル | 1 |

### 要件・仕様との突き合わせ

`spec.md`「3.」の受け入れ基準をすべて充足（`test.md`）。**must は 0 件**。

- 3c: `packages/core` の `dependencies` / `references` から hostserver が消え、
  `src` の参照も 0 件。web-ui バンドルは **359,853 バイトで完全一致**、
  `node:net` / `node:tls` / `hostserver` の実体とも 0 件
- 3d: 32 ファイル / 78 箇所を置換。**残した 5 ファイル**（別名の定義・公開 API の後方互換・
  同一性検査テスト・経緯のコメント）は走査で確認済み

### 指摘（review 内で修正済み）

- **[should] `AGENTS.md` の記述が 3c で古くなった。** 「`core` の依存は
  base, ebcdic, scs（＋hostserver は**型のみ**）」「残るのは `@as400web/core/browser` の
  **型のみ再輸出 3 箇所**だけ」と書いてあったが、**3c でその 3 箇所ごと無くした**。
  前作業（PR #235）で自分が書いた記述が、次の作業で自分の手で嘘になった形。
  **対応: 修正済**。「core はホストサーバーに一切依存しない（実行時も型も）」に改め、
  web-ui が `devDependencies` で `import type` する形を規約として明記した。

- **[should] `AGENTS.md` に「root の `tsc -b` は web-ui を検査していない」が書かれていなかった。**
  この作業で実際に踏んだ（decisions.md D5）——`browser.ts` の型を 1 つ消したとき
  **root のビルドは緑のまま** `packages/web-ui/test/use-ifs-tree.test.ts` が落ちた。
  web-ui は root の project references に入っておらず、しかも `tsconfig.test.json` で
  **test も型検査の対象**（core / hostserver は `include: ["src"]` なので慣習が違う）。
  既存の「ビルドに vue-tsc を含める」の項目はテンプレート型エラーの話で、この穴は別物。
  **対応: 修正済**（「ビルド・テスト」節に追記）。

### 設計面で確認したこと（指摘なし）

- **`import type` が実行時に消えている**ことを 3 通りで確認——バンドルサイズが 1 バイトも
  変わらない／`node:net` `node:tls` が 0 件／`hostserver` の文字列自体が 0 件。
- **宣言まで検査している。** ソースの参照が 0 でも `package.json` に残っていれば
  「実行時に引かないだけで依存はしている」状態に戻れるので、宣言そのものをガードに入れた
  （わざと戻して落ちることを確認済み）。
- **3d は同一クラスの別名置換**で振る舞いは変わらない。`errors-compat.test.ts` が
  新旧の同一性を検査し続けており、緑。外部利用者の互換は壊していない。
- **`DtaqEntry` / `DtaqType` を復活させていない**（web-ui での利用が実測 0 件。decisions.md D2）。

### 残す判断（対応しない）

- **`@as400web/base` の `Tn5250Error` 別名そのもの**は残す。外部利用者のための互換シムで、
  `errors.ts` の JSDoc が役割を明記している。
- **`tools/hostserver-check` を `@as400web/hostserver` 側へ移す**話（ツールの置き場所）は
  別軸。今回は import 元と識別子だけを扱った。

### この作業で踏んだ落とし穴（retro 向け）

**自分で書いた注意書きが、自分の書いたガードを誤検知させた**（decisions.md D6）。
`browser.ts` に「hostserver をここへ戻すな」と JSDoc を書いたところ、
`tsc` がコメントを出力に残すため `dist/browser.js` を読む検査が引っかかった。
`readDist()` でコメントを剥がして解決したが、**「成果物を読む検査」はコメントを
剥がしてから見るのが原則**という一般則を先に持っていれば避けられた。

### 集計

| 重大度 | 件数 |
|---|---|
| must | 0 |
| should | 2（いずれも修正済み） |
| nit | 0 |

修正後に `npm run build` / `npm run build -w @as400web/web-ui` / `npx eslint packages tools` /
全 8 パッケージのテストを再実行し、すべて緑（**269 files / 3,268 tests**、失敗 0）。
