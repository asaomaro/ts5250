# テスト結果: 継続欄の Erase EOF・Field Exit・Field±・Dup

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run`（継続欄・Field Exit・Dup・ペインの移動・カーソル送り・挿入に触れる web-ui のテスト 24 ファイル）— 507 passed / 0 failed / 0 skipped（`continued-field-exit.test.ts` の 16 件を足した）
- mutation（`scratchpad/mut-cfe.py`）— 18 通りのうち 16 通り落ちた（続く区間を消さない〔Erase EOF・Field Exit・Field+・Dup の各々〕・自分の区間も埋める・全桁埋めない・1 区間ずらす・`leaving` を出さない〔Field Exit・Field±・Dup〕・
  Dup が viaFieldExit を立てる・行き先を鎖の後ろにしない・中間／最終区間を飛ばさない・巡回しない・巡回先が最後の欄）。生き残った 2 つは等価変異
  （単独欄では `runOf` が自分だけの並びを返すので `continued` の早期 return を外しても同じ／続く区間を持つ区間に `fieldExitedIndex` は付かないので `erases` を外しても同じ）
- 実機（社内機・ACS のコア）: `scripts/acs-probe/continued-field-erase-exit.txt` を通しで実行（B1・B1b・B2・B4・B5・B6・B7・B3・B3b。dump 12 回）
- web-ui の型検査（`vue-tsc -b tsconfig.json tsconfig.test.json`）— エラーなし。全量と lint は節目で回す

## 受け入れ基準ごとの判定
- AC1: pass — Erase EOF は最初の区間の 2 桁目から `1` `` ``、2 区間目の途中から `1234` `5` ``。最後の区間はその区間だけ
- AC2: pass — Field Exit・Field+ も同じ消去。カーソルの区間の編集は従来どおり
- AC3: pass — Dup は `1` ＋ Dup 文字 3 個・続く区間は全桁 Dup 文字
- AC4: pass — 鎖の 1・2・最後の区間から Field Exit・Field+・Dup で鎖の後ろの欄、鎖が最後の欄なら最初の入力欄。継続欄でない欄は従来どおり。mutation 18 通りのうち 16 通りが落ち、2 通りは等価変異

## 失敗の証跡
このラウンドでは失敗が発生していない（テストの実行では）。mutation の 1 回目の実行で「自分の区間も埋める」が生き残ったので、カーソルの区間へ途中の値を出さないアサーションを足して落ちるようにした（生き残りの出力は
`$ python3 mut-cfe.py` の SURVIVED 行）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45265)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実ブラウザの打鍵（jsdom の keydown・メソッド呼び出しまで）
- DBCS の継続欄・CNTFLD の複数行欄（EDTMSK の日付欄だけ実機の ACS で測った。D3）
