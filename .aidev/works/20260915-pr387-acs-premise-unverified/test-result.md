# テスト結果: `PR#387` の ACS 前提が未検証だったことへの対応

> **訂正（2026-09-17）**: 本文中の「この開発環境には ACS が無い」「実機 ACS が無いため」は誤り。ACS の jar と、それを使う 5250-operator MCP・中継タップで実測比較できる（`decisions.md` D2 の訂正を参照）。記述は当時の判断の記録として残す。

## 実行したもの

- `npm run lint`（`eslint .`、monorepo全体） — エラー・警告 0
- `npm run build`（`tsc -b && vue-tsc -b`、monorepo全体） — エラー 0
- `npm run test`（`--workspaces --if-present`、monorepo全体、CI と同一コマンド）
  - `@ts5250/tn5250`: 586 passed（`cursor-default.test.ts` から4テスト削除、
    `cursor-stale-on-protected.test.ts` から3テスト削除、
    `sendaid-cursor-sync.test.ts` へ1テスト追加——review 工程の指摘を受けて
    追加した discrimination テスト、「レビュー指摘」参照）
  - `@ts5250/web-ui`: 2035 passed（`screen-grid-cursor-restore.test.ts` 含む、無変更）
  - `@ts5250/tn3270`: 254 passed / 38 skipped（既存の環境依存skip、本work と無関係）
  - `@ts5250/vt`: 202 passed
  - `@ts5250/gen-tables`: 10 passed
  - 合計: 3087 passed（既存の環境依存skipのみ、本 work によるものではない）

## 受け入れ基準ごとの判定

- AC1（`PR#387` 分岐の妥当性を、ACS のデコンパイル済みコアという一次資料に基づいて
  再評価し、コードをその資料と矛盾しない状態にする）: pass — `handleRecord()` から
  `PR#387` 分岐と専用の `cursorBeforeWasEnterable` 計算を削除し、`buffer.ts` の
  `isEnterableAt()`・`cursorIsUnenterable()`（呼び出し元が無くなったため）も削除した。
  タスク単位点検（T1・T2）・cross 点検（2ラウンド）で、削除の完全性・周辺コメントとの
  整合を確認済み。
- AC2（発見の経緯・実機同時比較ができない制約・将来の再検証の余地を記録）: pass —
  `research.md` F1〜F4（PR #387 の検証記録が無いこと、未チェックのチェックリスト、
  ACS コアのコード全文、利用者の記憶が不確かなこと）、`decisions.md` D2（判断の
  基準・代替案・影響）に記録済み。
- AC3（既存の関連テストに回帰が無いこと）: pass — `cursor-default.test.ts`
  （1つ目の describe ブロック、無変更のまま3テスト green）・
  `screen-grid-cursor-restore.test.ts`（無変更のまま5テスト green）を確認。
  加えて、実機（AS400/TESTLIB）で `scripts/diag-seu-protected-cursor-pageup.mjs`
  （SEU、3ケース）を再実行し、`PR#387` 分岐削除後も境界・非境界どちらのケースでも
  カーソル位置が正しく判定される（維持すべきケース1・2は維持、ホストが正当に
  動かすケース3は動く）ことを確認した。
- AC4（`cursor-stale-on-protected.test.ts` を新しい挙動に合わせて書き直す）: pass —
  1つ目の describe ブロックを「IC/MC の指定には保護欄でもそのまま従う」という
  新しい期待値に書き直し、2つ目の describe ブロック（PageUp/PageDown、区別する力を
  失ったため）を削除した。修正前のコードに対して新しい期待値が実際に失敗すること
  （discrimination）を確認済み。
- AC5（`.aidev/backlog/acs-parity.md` への記録）: pass — deliver 工程で実施
  （T6、下記「起動確認」の後に反映）。

## 実機での再確認（`PR#387` の元シナリオ）

`scripts/diag-cursor-after-expand.mjs` は既定で `CURSORCL`（`DSPATR(PC)` が
NAME 欄=展開後の入力欄に付く、正しく動く既定ケース）を呼ぶため、これでは
`PR#387` の実際のバグシナリオ（`CURSORCL3`＝`DSPATR(PC)` が**保護化される側**の
CODE 欄に付く）を再現しない。**`PGM=CURSORCL3` を指定して実行し直し**、
以下を確認した:

```
===== 2 画面目（上プロテクト・下が展開） =====
  カーソル: 3/12
  期待: ホストの DSPATR(PC) が指す NAME（10/12）にカーソルが付く
  実際: 3/12  → **ずれている（再現）**
```

`PR#387` 撤去後、カーソルは保護化された CODE 欄（3/12）に留まり、利用者が
Tab を押すまで NAME 欄（10/12）へ入力できない、という **`PR#387` 以前の挙動に
戻ったことを実機で確認した**。これは `design.md`「振る舞いの詳細」で説明した
通りの意図的な変更であり、退行ではない——ただし ACS が実際にこの場面でどう
見えるかは、実機 ACS が無いため今回も確認できていない（「未検証の穴」参照）。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":40,"time":1789467960689,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789467960707,"host":"127.0.0.1","port":46183,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 46183)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

この work は新しい入口（サブコマンド・オプション）を追加していないため、
`smokeCommands` の追加は不要。

## 未検証の穴（skip / 環境不足）

- **実機 ACS による直接確認は、この work のスコープでも引き続き不可能**
  （この開発環境に ACS が無い。`.aidev/works/20260914-seu-page-cursor-hold`
  decisions.md D6）。したがって「CURSORCL3 のシナリオで ACS が実際に
  カーソルを保護化された欄に留めるのか、それとも下の入力欄へ寄せるのか」は
  今回も確認できていない。本 work の変更は「確認できる唯一の事実（ACS コアは
  常に IC/MC に従う）に矛盾しない」という基準で判断したものであり、
  「ACS の実際の見た目の挙動と完全に一致する」ことを保証するものではない
  （`design.md`「エラー処理 / 異常系」参照）。将来、実機 ACS または利用者
  協力での実機同時比較が可能になった時点で再検証する必要がある
  （`.aidev/backlog/acs-parity.md` に記録、T6）。
- **一次調査でのミス（記録として残す）**: 実機再確認の当初の試行で
  `scripts/diag-cursor-after-expand.mjs` を既定のまま（`PGM` 未指定）実行し、
  誤って `CURSORCL`（正しく動く既定ケース）を対象にしてしまい、一見
  「カーソルが正しく NAME 欄に付いた」という誤った確認結果を得かけた。
  `PGM=CURSORCL3` を明示して実際のバグシナリオを対象にし直すことで、
  正しい再現・確認ができた。実機トレースを行うときは、対象プログラムが
  意図したシナリオと一致しているかを毎回明示的に確認する必要がある、という
  教訓として残す。
