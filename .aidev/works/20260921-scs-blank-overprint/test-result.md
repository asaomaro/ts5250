# テスト結果: SCS の空白の重ね書き

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run`（packages/scs 全量）— 78 passed / 0 failed / 0 skipped（追加 7 件。実採取 3 件〔DSPLIBL の SBCS・DBCS ほか〕の既存テストは不変）
- `tsc -p packages/scs --noEmit` — exit 0
- mutation（`scratchpad/mut-scs.py`・`mut-scs2.py`）— 8 通り（空白でも常に上書き・継続桁を占有と見ない・非空白の重ねも書かない・全角空白の 3 通り・書かない空白の生バイトで上書き・空白で maxCol を進めない）。
  **6 通りは 1 回目で落ち、2 通り（継続桁・maxCol）は生き残った**ので、継続桁のテストと `cols` のテストを足して落とした

## 受け入れ基準ごとの判定
- AC1: pass — `ABCDEF` CR `␠␠␠XY` → `ABCXYF`。空白だけの重ねも下の字が残る
- AC2: pass — 全角空白は全角の字・半角 2 字・2 桁にかかる半角 1 字の上で書かず、何も無い桁には書く。継続桁の半角空白も全角の字を壊さない
- AC3: pass — 字と字の間・行末の空白の桁（`cols` 5）・非空白の重ね（`XYCDEF`）は従来どおり
- AC4: pass — mutation 8 通りとも落ちる

## 失敗の証跡
mutation の 1 回目で生き残ったもの:

```
SURVIVED 継続桁を占有と見ない :: 76 passed (76)      → 足したテストで KILLED（1 failed | 77 passed (78)）
SURVIVED 空白で maxCol を進めない :: 76 passed (76)   → 足したテストで KILLED（1 failed | 77 passed (78)）
```

R11 の突合せ（本物の JPS と当 PJ に同じバイト列を読ませた記録。変更前）: `ABCDEF` CR `␠␠␠XY` は ACS が A B C を残し、当 PJ は `␠␠␠XYF`。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45347)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実帳票（重ね打ちを含むもの）の採取は未実施。非空白の重ねは未対応
- ACS の紙（PDF プリンター）の結果そのものは見ていない（JPS の描画命令の位置と字まで）
- server の PDF・web-ui の帳票表示は `lines` を受けるだけで、この変更の影響は空白が下の字の上に来る帳票だけ（全量は節目）
