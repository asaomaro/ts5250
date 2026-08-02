# テスト結果: `@as400web` → `@ts5250` の改名

## 自動テスト

| 対象 | 結果 |
|---|---|
| `npm run build`（`tsc -b` ＋ `vue-tsc`） | PASS |
| `npm run lint`（eslint） | PASS |
| `npm test`（全パッケージ） | **3,619 passed / 0 failed** |

**件数は改名前と同じ**（3,619）。テストを足しても減らしてもいない——名前だけの変更なので、
件数が動いたらそれ自体が異常。

## 「振る舞いが変わっていない」ことの示し方

差分が 469 ファイルと広いので、**行数ではなく差分の形**で示す。

```
git diff --cached -U0 -- '*.ts' '*.vue' '*.mjs' \
  | grep -E "^[+-]" | grep -v "^[+-][+-]" | grep -v "ts5250" | grep -v "as400web"
→ 出力なし
```

**コードの追加・削除行はすべて `as400web` か `ts5250` を含む行だけ。** 他は 1 行も動いていない。

## 依存の向きの検査が**空振りしていない**ことの確認

`dependency-direction` / `import-from-owner` / `ebcdic-not-reexported` /
`hostserver-not-reexported` / `log-independence` は**ソースを正規表現で走査**する。
スコープ名が変わったのに正規表現が旧名のままだと、**緑のまま何も検査しない**状態になる。

`packages/tn5250/src/index.ts` にわざと違反（`@ts5250/hostserver` の import）を入れて確認:

```
× 同位のパッケージが互いに依存していない
× `package.json` の宣言と実際の import が一致している
× src のどこからも hostserver を参照しない（例外なし）
→ 3 件が落ちる。戻すと 12 passed
```

**新しいスコープ名を実際に見ている。**

## 途中で踏んだこと（すべて直したうえでの結果）

### 1. 一括置換が 1 ファイルを取りこぼした

`grep -rl | xargs sed` で 639 箇所中 **638 箇所しか置換されず**、
`packages/server/src/db-pool.ts` の 1 行が残った。**気づいたのはビルドの失敗**
（`Cannot find module '@as400web/hostserver'` ＋ そこから波及した型エラー 6 件）。

置換コマンドは**成功したように見えていた**。以後は `os.walk` で全走査し、
**残り 0 を数えて**から進めた。

### 2. 検証コマンドを別ディレクトリから流して、2 つの検査を無効にした

依存検査の確認で `cd packages/tn5250` した後、**cwd が残ったまま**次を流した:

- `git status --short .aidev` → `packages/tn5250/.aidev` を見て**空**
  → 「`.aidev` は無変更」と誤って判断した
- `. ./.env` → **ファイルが無く変数が空**
  → `grep -F ""` が全行に当たり、秘密の走査が**18,849 件**という無意味な値を出した

**どちらも「緑に見える」形で壊れていた。** 陽性対照（既知の値を含むファイルを 1 件数える）を
入れて初めて、検出器が死んでいたと分かった。

### 3. その結果、`.aidev` の過去の記録 185 ファイルを書き換えていた

除外フィルタ（`grep -v '^\./\.aidev/'`）が効いていなかった（パスの先頭の `./` の有無）。
**過去の記録はその時点の事実**なので書き換えてはいけない。全件を `git restore` で戻し、
差分から消えたことを確認した（469 ファイルへ減）。

## 受け入れ基準

| 完了条件 | 結果 | 根拠 |
|---|---|---|
| `@as400web` が消えている（`.aidev` 除く） | PASS | `os.walk` 全走査で残り 0 |
| build / lint / test が通る | PASS | 3,619 passed（改名前と同数） |
| 依存の検査が空振りしていない | PASS | わざと違反を入れて 3 件落ちる |
| `package-lock.json` が整合 | PASS | `npm install` で再生成。旧名 0 / 新名 40 |
| `.aidev` の過去の記録が無変更 | PASS | 185 件を復元。`git status .aidev` が新規 work のみ |
| 利用者に見える名前 | PASS | README 見出し・Electron `productName` / `appId` |

## 未検証の穴

- **Electron の実ビルドはしていない**（`appId` / `productName` の変更が
  インストーラに正しく載るかは未確認）。Windows 実機が要る。
- **npm への公開はしていない**ので、`@ts5250` スコープの実際の取得は未実施。
