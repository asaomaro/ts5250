# テスト結果: telnet の残り（NEW-ENVIRON の答え方）

## 実行したもの
- `cd packages/tn5250 && npx vitest run` — 1090 passed / 0 failed
- `npx tsc -b`・`npm run lint` — エラーなし
- 実機（PUB400・tap）: ACS のコアと当 PJ の IS を変数の名前・値の長さで並べて一致（自動サインオンあり: `IBMRSEED USER DEVNAME KBDTYPE CODEPAGE CHARSET IBMSUBSPW IBMRSEED IBMSENDCONFREC`、なし: `IBMRSEED<シード> VAR DEVNAME KBDTYPE CODEPAGE CHARSET IBMSENDCONFREC`）。tap のログは shred
- 実機: `scripts/verify-autosignon.mjs PUB400`（暗号化・平文）OK、`scripts/verify-device-name.mjs` pass=5、社内機（930）・PUB400 の手でのサインオン OK（点検の手直しの後に流し直した）

## 受け入れ基準ごとの判定
- AC1: pass — 上の実機の並び・単体（`telnet.test.ts`・`telnet-printer.test.ts`・`associated-printer.test.ts`）
- AC2: pass — 上の実機

## 変異（verify-by-mutation）
- 6 通りすべて検出（シードをそのまま返す・固定の順・名前の無い DEVNAME を書かない・VAR にいつも USER・知らない変数を返さない。1 通りは最初に生き残り、`VAR JOB` のテストを足して検出）

## 失敗の証跡
このラウンドでは実装の失敗は発生していない。

## 未検証の穴（skip / 環境不足）
- シードの無い `USERVAR IBMRSEED` を送るホスト（未確認。コードに注記）

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 38014)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
