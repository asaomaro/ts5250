# 要件: 結果を返さない SQL 文（INSERT / UPDATE / DELETE / DDL）を SQL 画面から実行する

## 背景 / 課題

`.aidev/backlog/hostserver.md`「SQL の複数文実行からの積み残し」の 1 件目。

SQL 画面（`SqlPane`）で実行できるのは **SELECT だけ**。`query.ts` の `prepareAndOpen` が
文型と `openAttributes` を SELECT 固定で入れているため、それ以外は
「この結果セットは取得できません」で落ちる（`20260723-sql-multi-statement` research F1）。

前回の調査（同 research F2）は `executeImmediate`(0x1806) と `prepare`(0x1800) を実機で試し、
どちらも `rcClass=2 / -215` で拒否されたため**スコープ外**として backlog へ送った。
そのとき残された見立ては「**拡張形式の文テキストか RPB の設定が鍵**」。

**ただし、同じリポジトリの `insert.ts` は INSERT を実機で実行できている**——
`prepareAndDescribe`(0x1803) → `changeDescriptor` → `execute`(0x1805) の 3 段で、
`sqlStatementType = 1`。つまり**結果を返さない文を実行する道は既にある**可能性が高い。
`executeImmediate` を通す必要はないかもしれない。

## 目的 / ゴール

**SQL 画面から INSERT / UPDATE / DELETE / CREATE / DROP などを実行し、
影響した行数（または完了）を利用者に返す。**

## スコープ

### 対象

- 結果を返さない文の実行経路（core）。**既に動いている `prepareAndDescribe` → `execute` を使う**
- 文が SELECT か否かの判定（どちらの経路へ送るか）
- 影響行数の取得（SQLCA の更新件数）と表示
- SQL 画面での表示（結果表の代わりに「N 行更新しました」等）
- MCP の `host_sql` からも実行できるようにするか判断する
- **`;` 区切りの複数文**（既存の複数文実行に混ぜられること）

### 対象外

- `executeImmediate`(0x1806) / `prepare`(0x1800) を通すこと。**動く道があるなら不要**
  （通らない理由の解明は backlog に残す）
- コミットメント制御（トランザクション）。`COMMIT(*NONE)` 相当の現状を変えない
- 結果表の仮想化（同 backlog の別項目）
- 取得量の制御（`host_sql` の `maxRows`。同 backlog の別項目）

### 前提が崩れたときの扱い

`prepareAndDescribe` → `execute` が**マーカー無しの文で通らない**と分かった場合は、
実測を記録して**この作業を打ち切る**（`executeImmediate` の解明は別作業）。
推測で「通ったことにする」実装はしない。

## 機能要件

1. SELECT 以外の文を実行できる（DML と DDL の両方）
2. 影響行数が分かる文（INSERT/UPDATE/DELETE）では**行数**を返す
3. 行数の概念が無い文（CREATE/DROP 等）では**完了した**ことを返す
4. 失敗は理由付きで返る（構文誤り・権限・存在しない表）。**黙って成功に見せない**
5. SQL 画面で結果が読める（結果表と混ぜず、文ごとに何が起きたかが分かる）
6. `;` 区切りで SELECT と混在させても、文ごとに正しい経路へ行く
7. **既存の SELECT・CSV 取り込み（`insert.ts`）の挙動を壊さない**

## 非機能要件 / 制約

- **書き込みは取り消せない。** 成功と確認できたときだけ成功として扱う
  （`insert.ts` の `requireSqlca` と同じ安全側の判断）
- 文の判定は**純関数**として切り出し、単体テストで固定する
- 既存の結果セット（ページング・上限 4 本）の仕組みに影響させない
  ——結果を返さない文はカーソルを開かない
- **実機（）で確かめる**。プロトコル層はモックでは判定できない

## 完了条件 (受け入れ基準)

- [ ] `prepareAndDescribe` → `execute` がマーカー無しの文で通るかを実機で確かめ、記録した
- [ ] DML（INSERT/UPDATE/DELETE）が実行でき、影響行数が返る
- [ ] DDL（CREATE/DROP）が実行でき、完了が返る
- [ ] 構文誤り・存在しない表が理由付きで失敗する
- [ ] SELECT と非 SELECT の判定が純関数にあり、コメント・リテラル・`WITH` を誤らない
- [ ] SQL 画面で文ごとの結果が読める
- [ ] `;` 区切りで混在させても正しく振り分けられる
- [ ] 既存のテストが通り続ける（SELECT・CSV 取り込み）
- [ ] backlog の当該項目に結論が書かれている

## 未確定事項 / 確認したいこと

- マーカーが無い文で `prepareAndDescribe` が**マーカー形式を返すか**（`insert.ts` は無いと投げる）
- `execute` に**マーカーデータを載せない**形が受け付けられるか
- DDL でも `sqlStatementType = 1` でよいか（原典は SELECT=2 / OTHER=1 だが、
  当方の SELECT は 0 で動いている＝原典と対応していない）
- 影響行数は SQLCA のどの欄か（`insert.ts` の `updateCount` がそのまま使えるか）
