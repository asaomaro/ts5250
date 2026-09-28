# テスト結果: 全角の状態の E・J の欄のカーソルの桁と End

## 実行したもの
- `cd packages/web-ui && npx vitest run` — 2989 passed / 0 failed
- `cd packages/web-ui && npx vue-tsc -b` — OK
- `node --env-file=.env --env-file=.env.verify scripts/verify-browser-either-empty-view.mjs` — `RESULT: pass=7 fail=0`（直す前のコードでは `pass=2 fail=5`）
- `node --env-file=.env --env-file=.env.verify scripts/verify-browser-je-field.mjs` — `RESULT: pass=3 fail=0`（前の work の回帰なし）
- 変異 10 通り（詰め物・落とし方・End・`end` の空き・貼り付けの埋め）— すべて検出

## 受け入れ基準ごとの判定
- AC1: pass — `packages/web-ui/test/either-empty-view.test.ts`（10 件。期待値は ACS の測定）
- AC2: pass — 実機の DSM の JEEDIT でブラウザの End の 6 通りのカーソルとホストが受け取ったバイト列が ACS と一致

## 失敗の証跡
このラウンドでは差し戻しになる失敗は発生していない。直す前のコードでの実機の検証（差の裏付け）:

```
  FAIL e1 J `あい`＋全角空白の End: カーソル 5,19（ACS 5,15）
  FAIL e2 空の J の End: カーソル 3,19（ACS 3,11）
  PASS e3 compact の E の End（SI の後ろ）: カーソル 11,14（ACS 11,14）
  FAIL e4 中身の中から消した E（open）の End: カーソル 13,14（ACS 13,13）
  FAIL e5 半角から切り替えた E（full）の End: カーソル 9,14（ACS 9,13）
  FAIL e6 空にした全角の E の End（SO の次）: カーソル 13,10（ACS 13,11）
  PASS J1 のバイト列が ACS と同じ
RESULT: pass=2 fail=5
```

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 40755)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 挿入モードの複数行の貼り付け（`insertInto` の埋め）は単体が無い
- open の E の末尾に打った全角空白（decisions D2）・伏せ字の E・Dup
