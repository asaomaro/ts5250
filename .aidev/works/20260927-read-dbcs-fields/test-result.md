# テスト結果: READ の欄データの残り

## 実行したもの
- `cd packages/tn5250 && npx vitest run` — 1071 passed / 0 failed（`tls.test.ts` が 1 回、別 PJ の負荷〔load average 23〕で時間切れ。再実行で pass）
- `cd packages/server && npx vitest run` — 1627 passed / 0 failed（`app-auth`・`mcp-session-exclusion` が同じ負荷で 1 回落ち、負荷が下がって再実行で pass）
- `cd packages/web-ui && npx vitest run` — 2850 passed / 0 failed
- `npx tsc -b`・`npm run lint` — エラーなし
- 実機（社内機・930）`scripts/verify-read-dbcs-fields.mjs` — 直す前 pass=0 → 直した後 pass=3（9 欄。NUL だけの G・O を足した後も 3/3）
- 回帰 `scripts/verify-read-alt.mjs` — pass=3
- 実機の ACS のコア `scripts/acs-probe/read-dbcs-fields.txt` — 3 回（7 欄で 2 回・9 欄で 1 回）、同じバイト列

## 受け入れ基準ごとの判定
- AC1: pass — ACS のバイト列（research F2・decisions D4）と当 PJ が一致（実機・単体 `read-dbcs-fields.test.ts`）
- AC2: pass — 単体（`     -` → `40404040d0`・`    A-` → `40404040d1`）。0x42 のワイヤは未確認（decisions D2）
- AC3: pass — 単体（`pc-command-session.test.ts`: 0x42 を待つ PC コマンドの応答が SBA で始まらない）
- AC4: pass — `<AS400_LIB>/DSCMD` を DLTPGM（CPC2191 → CHKOBJ で CPF9801）・IFS の `/tmp/dscmd.c`・`/tmp/dscmd.log` を削除

## 変異（verify-by-mutation）
- 10 通りすべて検出: 末尾の実空白も落とす・ALT の NUL を 0x40・0x52 の NUL を 0x00・`sendValue` の生の経路を外す・G の生の経路を外す・区間ごとに落とす・NUL だけの欄を外す・平坦な形で数字のときだけ畳む・PC コマンドを 0x52 固定・PC コマンドのレコードで READ を憶えない

## 失敗の証跡
このラウンドでは実装の失敗は発生していない（負荷による時間切れは上に記載。再実行で pass）。

## 起動確認（smoke）
下に追記

## 未検証の穴（skip / 環境不足）
- 0x42 のワイヤ（DSM から ACS に 0x42 を答えさせられなかった。decisions D2）
- 奇数長の G 欄（decisions D3）・打鍵で書き換えた欄の後ろ（decisions D1）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 37932)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
