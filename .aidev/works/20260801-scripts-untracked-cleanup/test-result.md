# 検証結果: 未追跡の実機診断スクリプト 29 本を追跡下に入れる

実施 2026-08-01T09:19:52Z。**実機は使わない**——スクリプトは実機が要り、
このセッションから到達できない。静的検査のみで担保する（spec のとおり）。

## 受け入れ基準ごとの検証

| 受け入れ基準 | 結果 |
|---|---|
| `npm run lint` がリポジトリ全体でエラー 0 | **通過**（exit 0）。着手前は 6 件 |
| 29 本が追跡下に入る | コミット時に確認（deliver） |
| `192.0.2.1` が `scripts/` に 1 か所も残らない | **0 件**（`grep -rn … scripts/`） |
| 29 本が構文エラー無し | **`node --check` 29 本 / エラー 0** |
| `scripts/README.md` に族が記載 | 「画面採取・実測の族」節を追記（6 族・29 本） |
| `npm run build` / `npm test` | **通過 / 3,283 件すべて通過・失敗 0** |

## 変更した 6 本の内訳

### ホスト指定の env 化（5 本 7 か所）

| ファイル | 変更 |
|---|---|
| `check-html-determinism.mjs` | `HOST` を新設＋未設定チェック、`open_session` の `host` |
| `probe-ccsid.mjs` | 既存の `USER`/`PASSWORD` チェックに `HOST` を合流 |
| `shot-testlib-screens.mjs` | `const HOST = "…"` → env ＋未設定チェック |
| `shot-signedon.mjs` | `HOST` 追加、`open_session`、**出力メタ文字列** |
| `shot-signon.mjs` | `HOST` 追加＋未設定チェック、`open_session`、**出力メタ文字列** |

**出力メタの 2 か所が最も見落としやすい**——HTML に焼かれる説明文なので、
スクリプトを走らせても正常に動き、成果物の説明文だけが嘘になる。
`grep` の 0 件確認が実質唯一の検出手段だった（両方ともコメントで理由を残した）。

### 未使用変数（6 件）

- **削除 5 件**: `has`（`shot-buttons` / `shot-crt` / `shot-empsfl` / `shot-font`）・
  `constant`（`build-empsfl`）。いずれも 1 行で、要るときに書き直せる
- **`_probe` に改名 1 件**: `shot-fkey.mjs`（44 行の DOM 探査関数）。
  一度もコミットされておらず、消すと git 履歴にも残らない

## 未検証の穴（deliver へ引き継ぐ）

- **スクリプトを実行していない**。実機が要る。したがって
  「env 化した 5 本が実際に接続できる」ことは**確かめていない**。
  構文（`node --check`）と静的解析（eslint）までが担保の限界
  - 特に `AS400_HOST` 未設定時の `exit(2)` 経路は**未実行**。既存スクリプトの
    同じ形（`process.stderr.write` ＋ `process.exit(2)`）を写しただけ
- **無編集でコミットする 23 本の中身をレビューしていない**。実機でしか動かず、
  読んでも正しさは判定できない。**動く前提で受け入れる**のは spec の判断
- **既に追跡済みの `192.0.2.1`** は残る（`20260728-strpco-strpccmd/research.md` /
  `packages/web-ui/test/screen-export.test.ts:45,108`）。リポジトリは PUBLIC で既に公開済みであり、
  履歴の書き換えは割に合わない。後者はテストの期待値そのもの（spec で対象外と決めた）
