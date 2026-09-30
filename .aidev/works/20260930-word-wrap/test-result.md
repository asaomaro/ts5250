# テスト結果: 語送り

## 実行したもの
- `packages/tn5250` `npx vitest run` — 1248 passed / 0 failed
- `packages/web-ui` `npx vitest run`（パッケージ dir から） — 3011 passed / 0 failed
- `packages/server` `npx vitest run` — 1694 passed / 0 failed / 3 skipped
- `packages/hostserver` `npx vitest run` — 1022 passed / 0 failed
- `npm run build` ＋ `npm run build -w @ts5250/web-ui`（vue-tsc・test の型検査を含む）— 通過（途中、テストの `exactOptionalPropertyTypes` 違反 1 件を直した）
- 実機（`node --env-file=.env --env-file=.env.verify scripts/verify-browser-word-wrap.mjs`）— pass=8 fail=0（W1〜W8 のバイト列が実機の ACS のコアと一致）
- 変異: 21 通り。18 が KILLED、3 が最初は SURVIVED（最後の行の門番・空白の左の NUL・カーソルの境界・行の頭の下限・Backspace のフック）→ 分岐ごとのテストを足して全て KILLED。残った 1 つ（末尾の NUL を先に捨てる処理）は等価変異（あとの整理で同じ結果になる）。`continued === undefined` の条件は継続欄が 1 行に収まる区間しか許されないため到達不能で、条件ごと外した

## 受け入れ基準ごとの判定
- AC1: pass — `word-wrap.test.ts`（W1〜W8 を打鍵の模擬で再現。バイト列とカーソルが実機の ACS と一致。分岐ごとの端 6 件）
- AC2: pass — `word-wrap-field-edit.test.ts`（打鍵・Delete・Backspace・語送りでない欄・ホストが書いた NUL の持ち回り）
- AC3: pass — `word-wrap-field.test.ts`（READ MDT の途中の NUL は 40、ALT は 00、末尾の NUL は落とす、印は 1 行に収まる欄で立たない）
- AC4: pass — 実機 8 巡

## 失敗の証跡
このラウンドでは失敗が発生していない（テスト・実機とも初回で通った。変異で生き残った分はテストを足して殺した）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 40901)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 貼り付け・IME 確定・非表示の欄・継続欄の語送りは ACS の挙動が未測定（実装しない。台帳に残す）
- 3 行以上の語送りの欄の実機測定はしていない（`floor` の分岐は単体で ACS の手順どおりであることを確認）
