# テスト結果: 930（Katakana / Katakana Extended）を利用者に選ばせる設定

## 実行したもの

- `cd packages/base && npx vitest run` — 58 passed / 0 failed / 0 skipped（`device-env.test.ts` に930/5026 の変種のテスト 5 件を足した）
- `cd packages/ebcdic && npx vitest run` — 103 passed / 0 failed / 0 skipped（新規 `katakana-invalid-chars.test.ts` 3 件）
- `cd packages/tn5250 && npx vitest run` — 893 passed / 0 failed / 0 skipped（新規 `katakana-variant-charset.test.ts` 3 件）
- `cd packages/server && npx vitest run` — **1609 passed** / 0 failed / 3 skipped（`config-resolver.test.ts` に 3 件、
  `session-attach.test.ts` に 3 件、`config-store.test.ts` に 17 件〔下記レビューで追加〕を足した。
  複数回、`printer-hold-response` 系のテストが並列負荷のタイミングで落ちたが、都度再実行で緑——
  この work とは無関係な既知のタイミング依存フレーク〔このセッションの他の work でも既出〕）
- 合計（base+ebcdic+tn5250+server+web-ui）: **5294 passed / 0 failed / 3 skipped**
- `cd packages/web-ui && npx vitest run` — 2631 passed / 0 failed / 0 skipped（新規 3 ファイル 17 件:
  `field-validate.test.ts` の追記 4 件＋`katakana-variant-input.test.ts` 6 件＋
  `config-card-katakana-variant.test.ts` 7 件）
- `npm run build`（root `tsc -b` ＋ web-ui `vue-tsc -b tsconfig.json tsconfig.test.json`）— エラーなし
  （1 回目は新規テストの `ccsid: number | undefined` が `exactOptionalPropertyTypes` に引っかかって
  落ちた。`ccsid: number` に直して解消）
- `npm run lint` — エラーなし

## 受け入れ基準ごとの判定

- AC1: pass — `deviceEnvFor(930, "katakana")` が CHARSET 332（`device-env.test.ts`）、
  実際の telnet 申告も 332（`katakana-variant-charset.test.ts`）。入力は大文字化し
  （`katakana-variant-input.test.ts`）、8 記号（`[ ] ^ ` { } ~ ¢`）は拒否して操作員エラー状態に入る
  （`field-validate.test.ts`・`katakana-variant-input.test.ts` の「8 記号は拒否され、操作員エラー状態
  （施錠）に入る」）
- AC2: pass — `"katakana-ex"` は CHARSET 1172・小文字のまま・8 記号も入力できることを同じテスト群の
  対照ケースで固定
- AC3: pass — 930/5026 以外（`device-env.test.ts` の 939/1399・`katakana-variant-input.test.ts` の
  ccsid 37）では `katakanaVariant` を渡しても無視される。`ConfigCard.vue` の UI も
  930/5026 以外では選択肢が出ない（`config-card-katakana-variant.test.ts`）
- AC4: pass — 未指定は現状どおり（CHARSET 1172・大文字化する・8 記号は許可）であることを
  `device-env.test.ts`・`katakana-variant-input.test.ts` の両方で固定

## 失敗の証跡

このラウンドでは実装の失敗は発生していない。上記のとおり型検査で 1 回（`exactOptionalPropertyTypes`）
落ちたが、これはテストコード側の型の書き方の誤りで、実装のバグではない。

```
$ npm run build
> vue-tsc -b tsconfig.json tsconfig.test.json
test/katakana-variant-input.test.ts(40,21): error TS2379: Argument of type '{ ... ccsid: number | undefined; }'
  is not assignable to parameter of type 'SessionStateInit' with 'exactOptionalPropertyTypes: true'.
```

`seed()` の `ccsid` 引数を `number | undefined` → `number`（呼び出し側は常に値を渡していたため）に
直して解消した。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":30,...,"msg":"5250 MCP/Web server started..."}
smoke: /healthz ok, / が Web UI を返した (port 46631)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

この work は CLI サブコマンド・新規エンドポイントを足していない（既存の設定フォームへ項目を 1 つ
足しただけ）ので、`smokeCommands` への追加は不要と判断した——新しい表面（UI の選択肢・telnet 申告の
分岐）の検証は上記の各パッケージの単体・結合テストで直接確かめている。

## mutation

主要な分岐をすべて変異させ、対応するテストで検出することを確認した（すべて KILLED。生存 0）。

| 対象 | 変異 | 結果 |
|---|---|---|
| `device-env.ts` の `deviceEnvFor` | katakanaVariant を渡さない | KILLED |
| `session.ts` の `establish` | `opts.katakanaVariant` を渡さない | KILLED |
| `config-resolver.ts` | session の上書きを見ない／opts へ渡さない | KILLED（2 通り） |
| `ws-handler.ts` | 新規オープン／attach の opened から落とす／`buildDirect` が読まない | KILLED（3 通り） |
| `fieldValidate.ts` | katakana-invalid 判定を外す／真偽を反転 | KILLED（2 通り） |
| `EmulatorPane.vue` | `uppercaseInput`/`katakanaRestricted` が variant を見ない／ScreenGrid へ渡さない | KILLED（3 通り） |
| `ScreenGrid.vue` | `sessionKind.katakanaRestricted` を常に false | KILLED |
| `ConfigCard.vue` | v-if を隠す（システム・セッション）／`sesEffectiveCcsid` が親を見ない／編集読み込みで復元しない（2 か所） | KILLED（5 通り） |

## 未検証の穴

- **実機での確認は元の測定（`scripts/acs-probe/ccsid290-invalid-chars.txt`）のまま**——この work 自体は
  実機の新規測定を行っていない（既存の実測値をそのまま設定可能にしただけ）
- **実ブラウザでの UI 操作感は未確認**（jsdom のみ。`<select>` の操作感自体は既存の CCSID セレクタと
  同じ実装パターンなので、追加のリスクは低いと判断した）
- 5026 に Katakana / Katakana Extended の選択が実在するかは未確認（requirements の「対象外」に明記済み）
