# テスト結果: 透過の欄

## 実行したもの
- tn5250 `test/transparent-field.test.ts` — 6 passed
- 全量: tn5250 1,110 passed（DBCS の場合を足す前）／server 1,660 passed・3 skipped／web-ui 2,864 passed。`npm run lint`・`npm run build` exit 0
- mutation 9 通り（`scratchpad/mut-tr.json` 7・`mut-tr2.json` 2）——7 通り KILLED、2 通りは等価で生き残り（decisions D3）
- 実機（社内機）: `scripts/verify-transparent-field.mjs` — pass=1 fail=0。ACS のコア（`scripts/acs-probe/transparent-field.txt`）と同じ `11050a100008c1c2e7000000000011070ac3c4e8`

## 受け入れ基準ごとの判定
- AC1: pass — 実機で ACS と同じバイト列。単体で 0x52・0x82・下位バイトを問わない・透過でない欄は従来どおり・DBCS の原本
- AC2: pass（原典のみ）— 単体で READ INPUT はヌルを 0x00 のまま欄長ぶん

## 失敗の証跡
このラウンドでは失敗が発生していない。

```
原本を使わない SURVIVED Tests  6 passed (6)
後半桁を飛ばさない SURVIVED Tests  6 passed (6)
```
（等価の変異。decisions D3）

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴
- READ INPUT 系の ACS のワイヤ（DSM の 2 回目の読みが CPFA306 で待たなかった）
- 透過の欄の中の全角（実例なし）

## ラウンド 2（レビューの指摘を直した回）
- `test/transparent-field.test.ts` — 9 passed（0x83・0x72・0x1C のセル・継続欄・下位バイトの完全一致を足した）
- mutation 5 通り（`scratchpad/mut-tr3.json`）——元のバイト・hostByte・ヌル・継続は KILLED。「区間を切り詰めない」は生き残り、切り詰め自体が要らない防御だったので外した（decisions D4）
- 実機 `scripts/verify-transparent-field.mjs` — pass=1（2 回目。DSM を作り直して当て、片付けた）

```
区間を切り詰めない SURVIVED Tests  9 passed (9)
```

## 未検証の穴（追記）
- 中間・最終の区間にだけ 0x84 が付いた継続欄の扱い（先頭の区間の印で決まる）
