# テスト結果: 再順序付け

## 実行したもの
- tn5250 `test/resequence.test.ts` — 9 passed
- mutation 13 通り（`scratchpad/mut-rs.json`・`mut-rs2.json`）——11 通り KILLED、2 通りは等価（decisions D2）
- 実機（社内機・DSM の RESEQ）: ACS のコア 2 回とも `11070ac211050ac111090ac3`・`11070ac2`。当 PJ は直す前 `11050ac111070ac211090ac3`・`11070ac211090ac3`、直した後 ACS と同じ（`scripts/verify-resequence.mjs` pass=2）

## 受け入れ基準ごとの判定
- AC1: pass — 実機で ACS と一致。単体で鎖の順・MDT で止まる・最初の欄を飛ばす・番号 0・一巡
- AC2: pass（原典のみ）— 単体で MDT を問わず辿る・番号 0 は表の次
- AC3: pass（原典のみ）— 単体でカーソル送りの断り（0x10050125）・CLEAR UNIT のリセット・再順序付けの無い画面は画面順

## 失敗の証跡
直す前の当 PJ（実機）:

```
  1 回目=11050ac111070ac211090ac3 2 回目=11070ac211090ac3
  FAIL 3 欄とも打つと鎖の順（#2 → #1 → #3）で送る（ACS と同じ）
  FAIL #2・#3 だけ打つと #2 だけ（辿った先の #1 が MDT でないので止まる。ACS と同じ）
RESULT: pass=0 fail=2
```

## 未検証の穴
- READ INPUT 系の鎖・カーソル送りの断りは実機で出させていない（原典のみ）
- ACS が例外になる形（decisions D2）

## ラウンド 2（レビューの指摘を直した回）
- `test/resequence.test.ts` — 13 passed（SOH の本体 2 バイト・CUA・CFT・退避と復元・0x82・0x83 を足し、実測と原典・当 PJ の判断を書き分けた）
- mutation 6 通り（`scratchpad/mut-rs3.json`・`mut-rs4.json`）——CUA・CFT・退避・復元・SOH の長さ（`b[2]!` のまま `>= 1`）は KILLED。
  `mut-rs3` の「SOH の長さ 1 以上」は `?? 0` を付けた等価な書き方で生き残った（当て直した `mut-rs4` は KILLED）

```
SOH の長さ 1 以上で採る SURVIVED Tests  13 passed (13)
```
