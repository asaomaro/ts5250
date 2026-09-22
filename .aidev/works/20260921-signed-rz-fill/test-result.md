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

## 節目 11 の対応（独立点検 B の指摘を直した回）

### 実行したもの
- `cd packages/web-ui && npx vitest run test/field-adjust.test.ts` — 24 passed / 0 failed（`rightAdjust` の期待値を ACS の測定値に書き直し、空の欄・途中まで空・打った空白・符号付き＋RZ の空欄の各ケースを追加）
- `cd packages/web-ui && npx vitest run test/field-sign-dup.test.ts test/type-ahead.test.ts test/backtab-acs.test.ts test/home-key-acs.test.ts test/aid-field-exit-required.test.ts test/ffw-behavior-bits.test.ts test/field-adjust.test.ts` — 22 ファイル 416 passed（`rightAdjust` を呼ぶ経路すべて）

### 受け入れ基準の再確認
- AC1〜AC3: 変更なし。`rightAdjust` の空き判定を書き換えたが、既存の受け入れ基準（RZ/RB の埋め字・符号桁を動かさない）は保たれる。追加で「空の欄・途中まで空・打った空白」を ACS の測定値で固定した。

### 実機の測定
`node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs scripts/acs-probe/empty-adjust-field-exit.txt AS400`（新規の手順ファイル）。E1〜E6 の場合分けで、何も打たずに欄の先頭・途中（5 桁目・2 桁目）・打った空白 1 つ・符号付き＋RZ の空欄で Field Exit したときの ACS のコアの値と、ホストが受け取った値（`[...]` のエコー）を確かめた。

### mutation
`scratchpad/mut-b6.py`（空きを常に 0 にする・空きを常に全桁にする・内容を右へ動かさない）— 3 通りすべて検出（KILLED）。

### 未検証の穴
DBCS（J・G・E）の右寄せは今回も対応していない（現状 DBCS の Field Exit は `rightAdjust` を呼ばず、消すだけ。台帳に残した）。ホストが NUL で埋めた欄（画面消去のあと欄だけ立てた画面等）と、打った空白の欄との区別は、当 PJ の編集モデルが NUL を持たないため引き続き未対応。
