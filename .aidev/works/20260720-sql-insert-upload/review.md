# レビュー記録

## ラウンド 1（2026-07-20）

差分 `main...feature/sql-insert-upload`（34 ファイル・+2915/-674）をサブエージェントに委譲。
一次資料の照合を含まないため委譲した（protocol 2.6）。指摘は主エージェントが実機・コードで裏を取った。

**MUST 3 件・SHOULD 8 件・NIT 6 件**。うち 2 件は主エージェントが先に自力で見つけていた
（後述の「自分で見つけた 2 件」）。

### must

- [must] `insert.ts` **`changeDescriptor` が失敗を検出できない** / 対応: 修正済
  - ORS に `sqlca` を立てておらず、応答に SQLCA が無い。`assertOk` は SQLCA 不在を
    素通りさせるため、**サーバーが形式を拒んでも黙って実行へ進む**。
  - 対応: `ORS.sqlca` を追加。
- [must] `assertOk` が **3 方向に fail-open** / 対応: 修正済（**自分でも気づいていた項目**）
  - (1) 3 要求すべて `allowTemplateError: true` なのに `dbTemplate.rcClass` を見ていない
  - (2) `parseSqlca` は 136 バイト未満で `undefined` を返すため、**切り詰められた SQLCA が成功と区別できない**
  - (3) SQLCA 不在を成功扱い
  - 結果として `committedRows` に「書けていないかもしれない件数」が積まれ、
    「確実に書けた下限」という保証が壊れる。**巻き戻せない経路でこれは重い**。
  - 対応: template の戻りコードを判定に加え、**書き込み（execute）は SQLCA を必須**にした
    （読めない応答は失敗として扱う）。
- [must] `marker-encode.ts` **DECIMAL / NUMERIC が枠を検証せずに書き込む** / 対応: 修正済
  - 他の分岐はすべて `field.length`（サーバー申告）と突き合わせるのに、10 進系だけ
    `encodePacked` が `precision` から導いた幅をそのまま `out.set` していた。
    申告とずれると**隣の列のバイトを上書きする**（最終列なら `RangeError`）。
  - **このモジュールが自ら掲げる「型から幅を導かない」という不変条件に反していた**唯一の箇所。
  - 対応: `fitExactly` を追加し、申告と一致しなければ書かずに拒否する。

### should

- [should] `executeBatch` が **更新件数を確認していなかった** / 対応: 修正済
  - `parseSqlca` は `updateCount` を既に取り出していたのに使っていなかった。
    送った件数と一致しなければ失敗として扱うようにした。**成功を確認する唯一の積極的な信号**。
- [should] `upload-prepare` が **CSV ヘッダーの重複を通していた** / 対応: 修正済
  - 同じ列が 2 回あると `INSERT INTO t (A, A) VALUES (?, ?)` になり、
    「書く前に止める」という事前検査の目的を果たさずホストまで届く。
  - 対応: `column-duplicated` を追加して拒否。
- [should] `host-upload.ts` の**ヘッダーコメントが退役した DDM 経路を説明していた** / 対応: 修正済
  - AGENTS.md は「コメントは why を書く」としており、**古い why は無いより悪い**。
- [should] `TransferPane.vue` の `Rejection` が **core の型の手書き複製** / 対応: 修正済
  - 「種類を足したらここも足すこと」とコメントしていたが強制力が無く、
    実際に `value-invalid` を追従し忘れて理由が消えた（test 工程で実ブラウザ確認により発覚）。
  - 対応: `@as400web/core/browser` から `UploadRejection` を輸入。
    **種類が増えたらコンパイルエラーになる**形にした。
- [should] `isSupportedDataType` が **未使用** / 対応: 削除（**自分でも気づいていた項目**）
  - `upload-prepare` を縮小したとき唯一の利用者を失っていた。
- [should] `upload-prepare` が **DDM の `ColumnLayoutInput` に依存し続けていた** / 対応: 修正済
  - 使うのは `name` / `nullable` の 2 つだけ。退役したモジュールとの結合を切り、
    `UploadColumn` を定義した。
- [should] `insertRows` が **列名を検証していない** / 対応: **見送り**
  - 現状 `fetchColumnLayout`（ホスト由来）からしか来ないため攻撃経路ではない。
    ただし公開 API なので、区切り識別子を含む列名では不正な SQL になる。
    → **backlog へ**（後述）。
- [should] `host-sql.test.ts` の読み取り専用テストが **何も保証していなかった** / 対応: **見送り**
  - `CONFIG_ERROR` は資格情報の解決で出るため、`/api/host/sql` が INSERT を実行し始めても
    通ってしまう。指摘は妥当。→ **backlog へ**（意味のある固定には接続のモックが要る）。

### nit（対応: 見送り）

- `marker-encode.ts` の catch-all が、コーデックの不具合まで「CCSID 未対応」と報告する
- `insert.ts:57` の「必ず 1 往復に収まる」は幅の狭い表に限る（無条件に書いている）
- `TransferPane.vue` の `estimatedTrips` の既定値が `DEFAULT_MAX_BATCH_BYTES` と無関係
- `insert-batch.test.ts` の境界アサーションが `Math.max` で反証不能になっている
- `marker-encode.test.ts` の `fmt()` が `raw` を欠く（**`test/` が型検査対象外**なので通っている）
- MCP ツールの説明が `FLOAT` 等も扱えるように読める（実際は拒否する）

### 主エージェントが先に見つけていた 2 件

レビュー委譲と並行して、自分でも次を疑って確認していた:

1. **DDM 経路の未使用エクスポート** → `isSupportedDataType` が孤立していることを特定
2. **SQLCODE だけで失敗を判定していること** → `allowTemplateError` と SQLCA 不在の穴を特定し、
   レビュー結果が届く前に修正に着手していた

レビューはこれを裏付けたうえで、**`changeDescriptor` の SQLCA 欠落**と
**DECIMAL の枠未検証**という、自分では見つけられなかった 2 件を追加した。

### 所見

**MUST 3 件すべてが「失敗を検出できない」系**だった。この作業では実機で
「エラーにならないのに何も起きない」を 2 回踏んでおり、その都度直したつもりでいたが、
**同じ形の穴が残っていた**。書き込み経路では「成功と確認できたときだけ通す」を
既定にすべきで、今回 `requireSqlca` と更新件数の照合を入れたのはその方針への寄せ直しである。

もう一つ、**失敗判定の経路に単体テストが 1 件も無かった**（レビュー指摘 S10）。
バグが集中していた場所が丸ごと未検証だった。`DbConnection.request` を差し替えれば
単体で固められるので、12 件を追加した。

## 検証（修正後）

| | 件数 |
|---|---|
| core | 657 ✅（+12 失敗検出・+2 重複列） |
| server | 322 ✅ |
| web-ui | 458 ✅ |

`npm run build`（`vue-tsc` 込み）・`npm run lint` 通過。

**実機（PUB400）でも再確認**——(a) 基本 / (b) 日本語（基準行とバイト一致）/
(c) 0 行で拒否 / (d) 100 行 1 往復 / (e) `VARCHAR`・日付時刻・`GRAPHIC` がすべて通過。
更新件数の照合を足しても誤検知は起きていない。

## backlog へ送るもの

- `insertRows` の列名検証（公開 API としての防御）
- `/api/host/sql` の読み取り専用テストを実効あるものにする（接続のモックが要る）
- `packages/core` の `test/` が型検査対象外になっている（`tsconfig` の `include` が `src` のみ）
