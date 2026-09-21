# テスト結果: 符号付き＋RZ の欄の埋め字

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run`（RZ・RB・符号付きに触れる web-ui のテスト 12 ファイル）— 233 passed / 0 failed / 0 skipped（`field-adjust.test.ts` の旧い 1 件を書き換え、追加 3 件）
- mutation（`scratchpad/mut-rz.py`）— 6 通り（旧い順序に戻す・RZ／RB で符号桁を動かす・調整指定なしの符号付きで右寄せしない・符号桁を守らない・RZ を空白埋めにする）すべて落ちた
- web-ui の型検査（`vue-tsc`）と全量は節目で回す

## 受け入れ基準ごとの判定
- AC1: pass — 符号付き＋RZ は `000012`（Field− は `000012-`）、符号付き＋RB は `    12`（`    12-`）、符号桁は動かない
- AC2: pass — 符号付きで無指定・MF だけのときは `    12 `（従来どおり）
- AC3: pass — mutation 6 通りとも落ちる。破棄の証拠は decisions D1

## 失敗の証跡
このラウンドでは失敗が発生していない（書き換えた旧いテストは、意図した変更として結果が変わった: 旧 `    12 ` → 新 `000012 `。変異は 1 回目で全部落ちた）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45209)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- この変更後の当 PJ を実機の CHECK(RZ) 数値欄に当てていない（ACS 側の実測 M1・M2 と純関数の単体まで）
- 空きの数え方（NUL か空白か）・先頭の空白・DBCS 欄の右寄せは未測定（台帳）
