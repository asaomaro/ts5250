# レビュー記録

## ラウンド 1（2026-08-01T09:21:18Z）

編集した 6 本の diff と、無編集でコミットする 23 本の走査結果を点検した。

### 指摘

- [should] `scripts/shot-testlib-screens.mjs:21-25` — **env 化が既定の使い方を壊していた**。
  このスクリプトは `AS400_CCSID` を与えたときだけ host 直指定で開き、**未指定なら
  `connections.json` の保存値（`{ system: sysRef }`）で開く**（86 行）。
  つまり `AS400_HOST` は**条件付きでしか要らない**のに、無条件の
  `if (!HOST) exit(2)` を足したため、既定の（CCSID を上書きしない）実行が
  **起動直後に落ちる**ようになっていた。
  他の 4 本は `open_session` で無条件に `host` を使うので必須で正しい——**この 1 本だけが違った**。
  / 対応: **差し戻し（coding）**

- [should] `scripts/shot-testlib-screens.mjs:180` — 上と対の問題。note の
  `実機(${HOST})` は**無条件**に HOST を埋める。保存値で開いた回は HOST が
  `undefined` になり、成果物の説明文が `実機(undefined)` になる。
  / 対応: **差し戻しに同梱**

- [nit] `scripts/shot-spool-html.mjs:35` — `filter: { user: "USER" }` がハードコード。
  資格情報ではなくスプールの絞り込み値で、`TESTLIB` / `/home/USER` は追跡済みの
  README・スクリプトで既に多数使われている（本 PR で新たに露出するものは無い）。
  ライブラリ名を直書きする既存規約に沿っているので**許容**。
  / 対応: 許容

### 確認して問題なしだったもの

- **secret scan**: 29 本を再走査し、ハードコードされたパスワード・IP は **0 件**
  （`192.0.2.1` は `scripts/` から消えた）
- **README の族の本数**が実体と一致: `shot-*` 15 / `build-*` 3 / `probe-*` 3 /
  `check-*` 3 / `diff-*` 2 ＋単発 3 ＝ **29**（`git status` の実数で照合）
- **他 4 本の env 必須化は正しい**（`check-html-determinism` / `probe-ccsid` /
  `shot-signedon` / `shot-signon` はいずれも `open_session` で無条件に `host` を使う）
- **出力メタ文字列 2 か所**（`shot-signedon:87` / `shot-signon:54`）が
  変数から組まれている（固定文字列の残りなし）
- `_probe` の改名でスクリプトの挙動は変わらない（元から呼ばれていない）

### 判定

**must 0 / should 2 / nit 1** → **coding へ差し戻す**。

---

## ラウンド 2（2026-08-01T09:23:05Z）

### 反映

`shot-testlib-screens.mjs` を、**HOST が本当に要るときだけ要求する**形に直した。

- `if (CCSID_OVERRIDE && !HOST)` に変更。既定（保存値で開く）は AS400_HOST 無しで動く。
  なぜ条件付きなのかを JSDoc で残した
- note を `実機${HOST ? \`(${HOST})\` : ""}` に変更。**分かっているときだけ書く**
  ——保存値で開いた回に固定文字列やダミーを出すと、どのホストを撮ったのか説明文が保証できない

### 再検証（実行結果）

- `node --check scripts/shot-testlib-screens.mjs`: 通過
- `npx eslint scripts/`: エラー 0
- `grep -rn "172\.21\.10\.51" scripts/`: **0 件**
- `npm run lint`（リポジトリ全体）/ `npm run build` / `npm test`: 後述のとおり再実行して通過

### 指摘

**なし**（must 0 / should 0 / nit 0）。ラウンド 1 の nit 1 件（`user: "USER"`）は据え置き。

### 判定

**通過**（次工程: deliver）。
