# 仕様: 未追跡の実機診断スクリプト 29 本を追跡下に入れる

## 概要

29 本を「ホスト指定の env 化 → 未使用変数の解消 → README 追記 → コミット」の順で整える。
**中身の作り直しはしない**（実機が要り、検証できないまま触るのが最も危ない）。

## 設計方針

### D1: ホスト指定は `process.env.AS400_HOST`、既定値なし

追跡済みスクリプトの規約に合わせる（`scripts/diag-window-fkey.mjs:13` ほか。
`const host = process.env.AS400_HOST;` で、未設定なら使い方を出して `exit(1)`）。

`?? "192.0.2.1"` のような**既定値を持たせない**。既定があると
「env を渡し忘れたまま社内機へ繋ぐ」ことが黙って起きる。落ちた方が安全。

対象 7 か所:

| ファイル:行 | 形 |
|---|---|
| `check-html-determinism.mjs:22` | `open_session` の `host` |
| `probe-ccsid.mjs:29` | 同上 |
| `shot-testlib-screens.mjs:21` | `const HOST = …` |
| `shot-signedon.mjs:41` | `open_session` の `host` |
| `shot-signedon.mjs:84` | **出力メタの文字列**（画像に焼かれる説明文） |
| `shot-signon.mjs:27` | `open_session` の `host` |
| `shot-signon.mjs:48` | **出力メタの文字列** |

**メタ文字列（84 / 48 行）も変数に寄せる**。ここを直し忘れると、
env で別ホストに繋いだのに**成果物には社内 IP が書かれる**——嘘の証跡になる。

### D2: 未使用変数は「1 行なら消す・大きければ `_` を付けて残す」

lint 規約は `/^_/u` に一致する名前を許す（`@typescript-eslint/no-unused-vars`）。
価値の違いで線を引く。

| 対象 | 規模 | 扱い | 理由 |
|---|---|---|---|
| `has` × 4（`shot-buttons` / `shot-crt` / `shot-empsfl` / `shot-font`） | 1 行 | **消す** | `(await page.locator("body").innerText()).includes(t)` の別名。要るときに 1 行で書き直せる |
| `constant`（`build-empsfl-as400:40`） | 1 行 | **消す** | 同上（DDS 定数行の組み立て） |
| `probe`（`shot-fkey-as400:42-84`） | **44 行** | **`_probe` に改名して残す** | 画面の DOM から GUI 要素・入力欄・凡例を読み `probe-<label>.json` に落とす探査関数。**書き直しは安くない**。診断スクリプトが必要時に呼ぶ道具を持つのは不自然でない |

`_probe` には「今の通し実行では呼んでいない。要るときに呼ぶ」と 1 行の理由を添える。

**採らなかった案**: 6 件すべて消す。`probe` は 44 行で、しかも**一度もコミットされていない**
＝消すと git 履歴にも残らず永久に失われる。1 文字の改名で保てるものを捨てる理由が無い。

### D3: README は族でまとめる（29 行の表にしない）

`scripts/README.md` の「その他」節（223-228 行）が既に
「`verify-*` / `capture-*` / `diag-*` も同じ実行規約に従う」という**族で括る書き方**をしている。
29 本を 1 行ずつ表に足すと README が倍近くなり、既存の重い表（実機フィクスチャの説明）が埋もれる。

族の内訳（29 本）:

| 族 | 本数 | 中身 |
|---|---|---|
| `shot-*` | 15 | 画面・UI の実機スクリーンショット／HTML 採取 |
| `build-*` | 3 | `TESTLIB` に DDS/RPGLE のフィクスチャを作る |
| `probe-*` | 3 | 単発の実測（CCSID・窓の信号・`TESTLIB` 参照） |
| `check-*` | 3 | 不変条件の確認（HTML の決定性・メニュー排他・永続化） |
| `diff-*` | 2 | 実機とこちらの出力の突き合わせ（罫線・web-ui vs ホスト） |
| `list-testlib` / `research-ext-gui` / `verify-spool-html` | 各 1 | 一覧・調査・検証 |

## 対象範囲

- `scripts/` の未追跡 29 本（うち 6 本を編集、23 本は無編集でコミット）
- `scripts/README.md`（追記のみ）

**触らないもの**: 追跡済みの 73 本、`packages/`、既に公開済みの `192.0.2.1`
（`20260728-strpco-strpccmd/research.md`・`web-ui/test/screen-export.test.ts`）。

## 振る舞いの詳細

- env 化した 5 本は、`AS400_HOST` 未設定なら**接続前に落ちる**。
  既に `AS400_USER` / `AS400_PASSWORD` の未設定チェックがある本はその横に並べ、
  無い本は同じ形で足す
- 他 24 本の挙動は変えない

## ドメイン固有の考慮

- **AGENTS.md「秘密はコミットしない」**: パスワードは 29 本とも `process.env` 経由（走査済み）。
  本 spec で社内 IP も env に寄せるため、**新規に載る内部情報は無くなる**
- **`scripts/README.md` の実行規約**（`node --env-file=.env scripts/<name>.mjs`）に合わせる

## エラー処理 / 異常系

- `AS400_HOST` 未設定 → 使い方を出して `exit(1)`（既存スクリプトと同じ形）
- スクリプト自体の実行時エラーの扱いは変えない

## 受け入れ基準との対応

| requirement の完了条件 | 満たし方 |
|---|---|
| `npm run lint` エラー 0 | D2（6 件の解消） |
| 29 本が追跡下に入る | `git add scripts/` |
| `192.0.2.1` が `scripts/` に残らない | D1（7 か所）＋ `git grep` で確認 |
| 構文エラー無し | `node --check` を 29 本に回す |
| README に族が記載 | D3 |
| build / test が通る | `npm run build` / `npm test` |

## 未確定事項

なし（requirement の未確定 1 件は D2 で解消）。
