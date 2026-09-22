# テスト結果: Delete Word と既定キーの訂正

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run`（キー・削除・割り当てに触れる web-ui のテスト 27 ファイル）— 524 passed / 0 failed / 0 skipped（`delete-word.test.ts` の 33 件と、`keybindings.test.ts`・`host-error-mode.test.ts` の追加・更新を含む）
- mutation（`scratchpad/mut-dw.py`）— 22 通りのうち 21 通りが落ちた（全角・空白の 1 字・語頭の 3 条件・語の終わりで全角に止まる・語頭／途中の続く空白・欄の長さ・MDT・継続欄・DBCS の全角・修飾付き Backspace・Delete を止める〔SBCS・DBCS〕・
  エラー中の拒否・既定を戻す・移行〔Ctrl+Delete・Ctrl+Backspace・`null` で外す〕・版の数え）。生き残った 1 つは `hasKeyBinding` を外す変異で、割り当て済みでもイベントは親へ届き親が同じ preventDefault をするので挙動が変わらない等価変異
  （最初の実行で「語の終わりで全角に止まらない」も生き残ったので、実機で `AAあい BB` を測って d7・d8 を足し、落ちるようにした）
- 実機（社内機・ACS のコア）: `scripts/acs-probe/delete-word.txt` を通しで実行（a〜l・m・d1〜d8）と、`continued-field-erase-exit.txt` の B8
- web-ui の型検査（`vue-tsc -b tsconfig.json tsconfig.test.json`）— エラーなし。全量と lint は節目で回す

## 受け入れ基準ごとの判定
- AC1: pass — 純ロジックの表 12 行＋DBCS 8 行、ScreenGrid（SBCS・O・継続欄・保護欄・MDT）、ペイン（Ctrl+Delete）
- AC2: pass — `host-error-mode.test.ts`: Delete Word はエラーを抜けて語を消す。ほかの編集キーは従来どおり拒否
- AC3: pass — Ctrl+Backspace は値も DOM も変えず preventDefault、Erase EOF は割り当てれば効く（SBCS・DBCS）
- AC4: pass — 版 2〜4 の古い既定は移り、自分で変えた値・消した割り当ては壊れない。版 1 の人には新しい既定が入る
- AC5: pass — mutation 22 通りのうち 21 通りが落ち、1 通りは等価変異

## 失敗の証跡
このラウンドでは失敗が発生していない（テストの実行では）。既存テスト 3 件（`aid-field-exit-required.test.ts` の Erase Input の後・`host-error-mode.test.ts` のエラー中の Erase EOF・Erase Input）は、
既定のキーの変更（Ctrl+Backspace が Erase Input でなくなった・Ctrl+Delete が Erase EOF でなくなった）で意図どおり落ちたので、ACS の既定（Alt+End・割り当てて確かめる）へ書き換えた。
mutation の 1 回目で「語の終わりで全角に止まらない」が生き残った（出力は `$ python3 mut-dw.py` の SURVIVED 行）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45255)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実ブラウザの打鍵（jsdom の keydown まで）。ブラウザの語削除の抑止（`preventDefault`）が実ブラウザで効くか
- 欄内の選択があるときの `[deleteword]`・J・G・E の欄・NUL の扱い（D5）
- Alt+←/→・`¬ ¢ £` の Alt 入力・Ctrl+Home・Ctrl+F11 は別の差（台帳）

## 節目 11 の対応（独立点検 B の指摘を直した回）

### 実行したもの
- `cd packages/web-ui && npx vitest run test/keybindings.test.ts test/aid-field-exit-required.test.ts test/delete-word.test.ts` — 87 passed / 0 failed（`latestBindingsVersion` のテスト 2 件、「出た」状態を下ろすテスト 1 件を足した）

### 受け入れ基準の再確認
- 変更なし。上記 3 件はいずれも既存の受け入れ基準の裏付けを強めるテスト。

### mutation
`scratchpad/mut-b12.py` の一部（`latestBindingsVersion` を追加のみの最大にする）— 検出（KILLED）。

### 未検証の穴
変更なし。
