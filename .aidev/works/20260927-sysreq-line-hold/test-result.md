# テスト結果: SysReq の行の保留・保留の間の CC2・READ の印

## 実行したもの
- `cd packages/tn5250 && npx vitest run` — 1066 passed / 0 failed
- `cd packages/server && npx vitest run` — 1627 passed / 0 failed / 3 skipped（既存の skip）
- `cd packages/web-ui && npx vitest run` — 2850 passed / 0 failed
- `npx tsc -b`・`npm run lint`・`cd packages/web-ui && npx vue-tsc -b` — エラーなし
- 実機（社内機・930）`node --env-file=.env --env-file=.env.verify scripts/verify-sysreq-line-hold.mjs` — pass=4 fail=0
- 同 `… HOLDCC2` — pass=2 fail=0
- 同 `… SUBMIT` — pass=5 fail=0
- 実機の ACS のコア: `sysreq-line-hold.txt`（Reset で閉じる）・`sysreq-line-hold-submit.txt`（送信で閉じる。2 回目の観測）・`hold-cc2.txt`（tap-proxy を挟んで 2 回目）

## 受け入れ基準ごとの判定
- AC1: pass — ACS は行の間に届いた LATE を出さず、Reset で閉じても送信で閉じても出した（送信で閉じた経路は、システム要求のメニューから F12 で戻った画面の 5 行目が `LATE`）。当 PJ も同じ（溜めに 2 本あることを確かめてから、行の間は空・閉じたら LATE）。単体: `host-error-hold.test.ts` の SysReq の行の節（CLEAR UNIT・WEC で閉じる・別の AID で閉じる・溜めの上限）
- AC2: pass — ACS のワイヤ（tap）で、HOLDCC2 は 1 本のレコード `WTD CC2=01（点ける）・0x21 "HOLD ERR"・WTD CC2=00・5,2 HELD` だった。ACS は保留の間 mw=false、Reset の後 mw=true（2 回とも同じ）。当 PJ も保留の間は点かず、抜けて流し終えて点く。単体: 警報の持ち越し・後の WTD が消す・後続のレコードの指定を上書きしない
- AC3: pass — 単体（`wec-only-unlock.test.ts`）: CANCEL INVITE で印が下りる・RESTORE で退避の時点の値に戻る（READ が出ている SAVE → true / 出ていない SAVE → false の対照）
- AC4: pass — 実機の `<AS400_LIB>/DSCMD` を DLTPGM（CPC2191 → CHKOBJ で CPF9801）・IFS の `/tmp/dscmd.c`・`/tmp/dscmd.log` を削除。tap のログは shred

## 変異（verify-by-mutation）
- コア 10 件: 9 件 KILLED。`isRemainder` を外す変異だけ生き残り——等価な変異（decisions D4）
- server 7 件: すべて KILLED（予約で閉じない・予約中の close を拒む・切断で閉じない／いつも閉じる・3270 の除外を外す・review ラウンド 1 の SysReq が断られたとき閉じない・読み取り専用で開くを受ける）
- web-ui 10 件: すべて KILLED（最初の実行で 2 件生き残った——`sysReqLineSeen` の判定と二重の open。テストを足して開き直しの欠陥を直した）

## 失敗の証跡
このラウンドでは失敗が発生していない（変異で生き残った 2 件はテストの穴で、実装の失敗ではない。上の「変異」節）。

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 38202)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 溜めた AID（`deferredAid`）の間に Attn / SysReq を押したとき ACS が溜めを捨てるか——手順が組めず未確認（decisions D1）
- 画面から入った行の間に MCP が AID を送る組み合わせは単体だけ（実機で ACS と比べられない。ACS は 0006 で当 PJ は閉じて送る。decisions D2）
