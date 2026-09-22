# テスト結果: 語頭ジャンプ

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run test/keymap.test.ts test/use-cursor.test.ts test/pane-word-jump-input.test.ts test/keybindings.test.ts` — 79 passed / 0 failed / 0 skipped（`use-cursor.test.ts` に 6 件・`keymap.test.ts` に 1 件を足し、旧仕様の期待 2 件を更新した）
- mutation（`scratchpad/mut-wt.py`）— 9 通りのうち 6 通り落ちた（全角を 1 字ごとに数えない・行頭を常に語頭にする・端で巻き戻らない・向きを逆にする・Alt+←/→ を割り当てない・Alt+Shift も割り当てる）。
  生き残った 3 つは等価変異（先頭の桁の特別扱いは範囲外の桁が空白を返すので同じ／全角の後半桁は直前の字が非空白で語頭にならない／最後の 1 歩〔自分自身〕をたどらなくても `pos` を返して同じ）
- 実機（社内機・ACS のコア）: `scripts/acs-probe/tabword.txt`（30 歩ずつ前後・画面の端）
- web-ui の型検査（`vue-tsc -b tsconfig.json tsconfig.test.json`）— エラーなし。全量と lint は節目で回す

## 受け入れ基準ごとの判定
- AC1: pass — 全角 1 字ごと・SI の直後・実機のメニューの停止位置（2・30・34・36・38・40）を再現
- AC2: pass — 画面の端で巻き戻る・行頭は前の行の最終桁が空白のときだけ語頭・語が全く無ければ動かない
- AC3: pass — Alt+←/→ が語頭ジャンプ。Alt+Shift・Ctrl+Alt は対象外

## 失敗の証跡
このラウンドでは失敗が発生していない（テストの実行では）。旧仕様のテスト（`pane-word-jump-input.test.ts` の DBCS の語・`use-cursor.test.ts` の端で停止）は、ACS の実測に合わせて期待値を更新した。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45019)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 文字が行末から次の行へ続く画面の行頭（原典の読み）・実ブラウザの Alt+←/→（D3）

## 節目 11 の対応（独立点検 A・B の指摘を直した回）

### 実行したもの
- `cd packages/web-ui && npx vitest run test/pane-word-jump-input.test.ts test/use-cursor.test.ts test/keymap.test.ts` — 57 passed / 0 failed（コードは変更していないので回帰なし）

### 受け入れ基準の再確認
- 変更なし。README・コメント・decisions.md の記述を実態に合わせただけ。

### 未検証の穴
変更なし（DBCS の後ろに SI の無い半角の語頭は引き続き未確認）。
