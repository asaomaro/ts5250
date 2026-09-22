# テスト結果: WTD の制御バイトを表示データにする

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run`（tn5250 全量）— 868 passed / 0 failed / 0 skipped（`wtd-applier.test.ts` は旧い「未知オーダー」の 2 件を書き換え、制御バイトの 4 件を足した）
- `npx eslint`（変更した 4 ファイル）— exit 0 / `tsc -b` — exit 0
- mutation（`scratchpad/mut-ctl.py`・`mut-ctl2.py`）— 11 通り（分岐を外す・桁を進めない・元のバイトを持たない・範囲の 6 通り〔下限・上限・0x16・0x1B・0x1C/0x1D・SO/SI〕・0x07 の表示 2 通り）。**10 通りは 1 回目で落ち、SO/SI まで含める 1 通りは生き残った**——`isControlData` を 0〜255 全部で固定するテストを足して落とした（主ループは SO/SI を先に処理するので、関数の範囲だけの変異だった）
- 実機（社内機）: 修正後の当 PJ で `CTLBYTES` を受け、ACS のコアと同じ並び（3〜8 行・カーソル (10,10)・入力欄 1 つ）になった

## 受け入れ基準ごとの判定
- AC1: pass — 15 個すべてが 1 桁を占め、警告が出ない
- AC2: pass — 後ろの SBA・SF・IC・ESC READ が生きる
- AC3: pass — 画面イメージの応答に元のバイトが並ぶ
- AC4: pass — 0x07 だけ DEL・ほかは空白。境界（ESC・SO/SI・0x1C・0x1E・0x1F）は従来。`isControlData` は 0〜255 で固定
- AC5: pass — mutation 11 通りとも落ちる

## 失敗の証跡
直す前の当 PJ（実機の社内機。`DIAG_SCREEN=1 DSCMD_PGM=CTLTST node scripts/diag-5250-commands.mjs CTLBYTES SBA10`）:

```
===== CTLBYTES =====
  [warn] unknown order 0x5 — skipping to next command
   3|   A
  カーソル (1,1) 施錠=false
===== SBA10 =====
  [warn] record parse error: address out of range: row=1, col=0 head=002012a0000004000002041100001101
```

ACS のコア（`scripts/acs-probe.mjs scripts/acs-probe/wtd-control-bytes.txt`）:

```
=== ctlbytes cursor=10,10 inhibit=0 ...
03|  A B C\x7fD E
04|  F G H I J
05|  K L M N O P Q
06|  R█S T
08|  UVW
=== sba10 cursor=1,1 inhibit=0 ...
03|  ABC
```

mutation の 1 回目で生き残ったもの:

```
SURVIVED SO/SI まで含める :: 70 passed (70)   → 足したテストで KILLED（1 failed | 70 passed (71)）
```

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 44935)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- ACS の GUI がこれらの桁をどう描くかは測れない（コアの表示面まで）
- ホストが実際に 0x05〜0x0D・0x16〜0x1B を送る画面は見つけていない（同じ族の 0x1C・0x1F は届いている）。M5（通常の画面の警告集計）は受動観測で、未実施
- SBA(1,0) は実装していない（decisions D3）
