# テスト結果: 交渉の前のテキスト

## 実行したもの
- `packages/tn5250` `npx vitest run` — 1263 passed / 0 failed（新規 `nvt-text.test.ts` 15 件、`telnet.test.ts` は先に EOR を交渉する形へ 1 件直した）
- `packages/server` `npx vitest run` — 1694 passed / 0 failed / 3 skipped（`Session5250` を使う側の確認）
- `npm run build`（tsc -b・web-ui の vue-tsc を含む）・`eslint`（telnet・session・新規テスト）— 通過
- 偽のサーバーで ACS のコアと画面比較（`node scripts/verify-nvt-text.mjs`）— pass=9 fail=0
- NVT の見分けを切って同じ比較を流した対照 — 9 通りとも `no screen within 5000ms`（修正前の状態）
- 変異: 20 通り。17 が初回から KILLED、3 が SURVIVED（BINARY だけの分岐 2・最初のレコードの権利）→ BINARY のテストを「EOR の前の受信の終わり」で確かめる形に強め、冗長だった `firstRecord = false` を外して復元だけを残し、全て KILLED

## 受け入れ基準ごとの判定
- AC1: pass — `nvt-text.test.ts`（書き出しのバイト 7 件）、偽のサーバーの 9 通りが ACS のコアと一致
- AC2: pass — `nvt-text.test.ts`（telnet 層 7 件）
- AC3: pass — `nvt-text.test.ts`（バナーが画面に出て施錠のまま・あとの起動応答が最初のレコード）

## 失敗の証跡
このラウンドでは失敗が発生していない（単体は初回で通った。`telnet.test.ts` の 1 件は実装の意図した変更〔分割した受信は交渉の後にレコードになる〕に合わせて直した）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実際のゲートウェイ・プロキシは使っていない（偽のサーバーだけ。IBM i は交渉前にテキストを送らない）
- 画面の終わりを越えた後に ACS が動かなくなる状態は写していない（decisions D2）
- 3270 の NVT・NVT への入力は対象外
