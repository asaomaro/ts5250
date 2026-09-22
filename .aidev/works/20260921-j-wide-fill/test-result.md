# テスト結果: J の詰め物

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run`（DBCS・挿入・貼り付け・IME・欄の編集・継続欄・削除・MF に触れる web-ui のテスト 43 ファイル）— 647 passed / 0 failed / 0 skipped（J の 3 件を足した）
- mutation（`scratchpad/mut-jw.py`）— 5 通りすべて落ちた（J・G の詰め物を半角空白に戻す・E の詰め物も全角空白にする・末尾の全角空白を落とさない・E・O の全角空白も落とす）
- 実機（社内機）: core への `setField` で J の `あ   い` が FIELD_TYPE・`あ　　　い` が通ることを確認
- web-ui の型検査（`vue-tsc -b tsconfig.json tsconfig.test.json`）— エラーなし。全量と lint は節目で回す

## 受け入れ基準ごとの判定
- AC1: pass — 離れた空き桁に打った値が `あ　　い`（半角空白なし）
- AC2: pass — NUL 空きの J を触っただけでは編集にならない。末尾の詰め物は落ちる
- AC3: pass — E・O の既存テストが通る。mutation 5 通りとも落ちる

## 失敗の証跡
このラウンドでは失敗が発生していない（テストの実行では）。修正前の出力が証跡で、J の欄に `あ` を置いて離れた空き桁へ `い` を打つと、編集の値が `"あ   い"` になった（一時のテストで採った）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45635)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実ブラウザの打鍵（jsdom まで）。ACS が NUL 空きの J に打つときの前の空きの扱い（D2）

## 節目 11 の対応（独立点検 B の指摘を直した回）

### 実行したもの
- `cd packages/web-ui && npx vitest run test/dbcs-pure-field.test.ts` — 24 passed / 0 failed（J・G × Erase EOF/Field Exit/Field± の 6 件、E の桁数の確認 1 件を足した）

~~上の「43 ファイル 647 passed」は対象ファイルの一覧が無く再現できない（独立点検 B-N5）~~ → 対象を「G・J 双方に触れるテストファイル」に絞って書き直す:
`test/dbcs-pure-field.test.ts`・`dbcs-insert-room.test.ts`・`dbcs-space-key.test.ts`・`field-adjust.test.ts`・`continued-field-exit.test.ts`・`ime-flow-next-field.test.ts` の 6 ファイル 116 passed（節目 11 時点）。

### 受け入れ基準の再確認
- AC1: 追加で「Erase EOF・Field Exit・Field± の後に右へ動いて打っても半角空白が混ざらない」を固定（以前は打鍵・Delete 経路しか固定していなかった）。

### mutation
`scratchpad/mut-b12.py`（`eraseToEndDbcs` を消した空きを半角空白のままにする・Erase EOF/Field Exit/Field± だけ旧処理に戻す）— 4 通りすべて検出（KILLED）。

### 未検証の穴
実機での確認は「打鍵で離れた空きへ打つ」経路のみ（`かきく` の 3 字）。Erase EOF の後に右へ動いて打つ経路そのものは実機では測っていない（core の拒否ルールは既存テストで確認済みの箇所を再利用）。
