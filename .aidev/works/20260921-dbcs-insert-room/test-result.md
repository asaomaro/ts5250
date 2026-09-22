# テスト結果: DBCS の欄の挿入モードの余地

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run`（DBCS・挿入・貼り付け・IME・欄の編集に触れる web-ui のテスト 37 ファイル）— 552 passed / 0 failed / 0 skipped（`dbcs-insert-room.test.ts` の 19 件を足した）
- mutation（`scratchpad/mut-dir.py`）— 13 通りのうち 12 通り落ちた（全角空白を数えない・O でも数える・E を外す・J を外す・最終桁の判定を外す・置換にも掛ける・上書きにも掛ける・1 桁ずらす（前後）・keydown / IME で `replaced` を渡さない・貼り付けの通知を外す）。
  生き残った 1 つは G の除外で、G 欄の桁数の別の差（R11 (j)）が直るまで観測できない等価変異
- 実機（社内機・ACS のコア）: `scripts/acs-probe/dbcs-insert-room.txt` を通しで実行（A〜E・G。dump 20 回）と、F（O の末尾が全角空白）を単独で実行
- web-ui の型検査（`vue-tsc -b tsconfig.json tsconfig.test.json`）— エラーなし。全量と lint は節目で回す

## 受け入れ基準ごとの判定
- AC1: pass — J・E で `あい□□□` の先頭・3 スロット目への挿入が成功し、満杯は 0012 で値が変わらない
- AC2: pass — SI の桁（J・E）・最終のセル（O）は 0012、1 桁手前は成功。上書きは最終のセルでも入る
- AC3: pass — O の末尾が全角空白の満杯欄は 0012（実機の測定 F1 と同じ）
- AC4: pass — mutation 13 通りのうち 12 通りが落ち、1 通りは等価変異（D2）。貼り付け・IME の確定・選択の置換もテストで固定

## 失敗の証跡
このラウンドでは失敗が発生していない（テストの実行では）。mutation の 1 回目の実行で 6 通りが生き残ったので、O の全角空白・置換・上書き・貼り付け・IME のテスト 5 件を足して 12 通りが落ちるようにした（生き残りの出力は
`$ python3 mut-dir.py` の SURVIVED 行。O でも全角空白を空きに数える / 置換の挿入にも最終桁の判定を掛ける / 上書きにも掛ける / G を外さない / keydown・IME で replaced を渡さない / 貼り付けの通知を外す）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45281)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実ブラウザの打鍵・IME（jsdom の keydown まで）
- 選択を置き換える打鍵が最終桁のとき・複数字の貼り付けが最終桁で拒否された後の続き（ACS の挙動が未確認。D3・D4）
- O の SO/SI を含む必要桁（測定 C3・C4 で ACS は 0012、当 PJ は成功する）・G 欄の桁数・継続欄への IME 確定は別の差（台帳）
