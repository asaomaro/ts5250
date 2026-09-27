# テスト結果: WTD の中の否定応答・受理の残り

## 実行したもの
- `cd packages/tn5250 && npx vitest run` — 1088 passed / 0 failed
- `cd packages/server && npx vitest run` — 1627 passed / 0 failed / 3 skipped（既存）
- `cd packages/web-ui && npx vitest run` — 2850 passed / 0 failed
- `npx tsc -b`・`npm run lint` — エラーなし
- 実機（社内機・930）`scripts/verify-wtd-order-sense.mjs` の新しい 8 モード — pass=33（点検の手直しの後、SF の 7 モードを流し直して pass=29）。既存 8 モードの回帰 — pass=27
- 実機の ACS のコア（DSM の WTDERR*）— 2 回（1 回目は tap でセンスを採った）、同じ結果
- 通常の画面の一巡（DSPLIBL・WRKACTJOB・WRKSPLF・DSPJOB・WRKOBJ・DSPMSG・GO MAIN・WRKUSRJOB・DSPSYSVAL・CRTLIB）: 社内機（930）・PUB400（37）とも 20 画面で否定応答 0 件

## 受け入れ基準ごとの判定
- AC1: pass — SBA 1,0 → SF → AB が 1 行 1 桁の入力欄・FFW 0xC000 が入力欄（実機・単体）。属性は 1 行 1 桁から効く（原典・単体）
- AC2: pass — 24,75 から TD 10 バイトは 24 行を書かず 0x10050121・CC2 も効かない（実機・単体）
- AC3: pass — 長さ 0・画面の末尾を越える・長さ 5 の J・先頭の無い継続欄の中間は 0x10050125（実機・単体）。長さ 1 の O・継続欄の nn・ワードラップの組・自己点検の 33 桁・同じ位置／後ろの欄（原典・単体）。属性 0x10050130（原典・単体。decisions D1）
- AC4: pass — `<AS400_LIB>/DSCMD` を DLTPGM（CPC2191 → CHKOBJ で CPF9801）・IFS の `/tmp/dscmd.c`・`/tmp/dscmd.log` を削除、tap のログは shred

## 変異（verify-by-mutation）
- 14 通りすべて検出（SBA 1,0 で例外・FFW を厳しく・TD を打ち切らない・欄の検査を外す・属性の検査を外す・後ろの欄を見ない・FFW を書き換えない・番地 -1 の属性・CLEAR UNIT で捨てない・長さ 1 の O を断る・継続欄の順を緩める・ワードラップの組を見ない・33 桁・継続欄の状態を戻さない）

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 未検証の穴（skip / 環境不足）
- 0x10050130 は実機で測れない（製品の旗。decisions D1）
- 番地 -1 に SF 以外（decisions D6）・再順序付けの組・FFW の無い SF の検査（decisions D7）
- WDSF の中の否定応答（台帳に割って残す）

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 39814)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
