# テスト結果: SCS の重ね打ち・罫線・半分の幅

## 実行したもの
- `packages/scs` `npx vitest run` — 118 passed / 0 failed（新規 `scs-overlay.test.ts` 22 件、`spool-html.test.ts` 5 件、`scs.test.ts` は SFSS の半分の幅の期待を 1 件直した）
- `packages/server` `npx vitest run` — 1695 passed / 0 failed / 3 skipped（`pdf.test.ts` に 1 件）
- `packages/web-ui` `npx vitest run`（パッケージ dir から） — 3027 passed / 0 failed（`report-text-shift-marks.test.ts` に 3 件。最後に scs のテストだけを足したので、`ReportText`・`SpoolPane` のテストを再実行して 28 passed）
- `npm run build`（tsc -b・web-ui の vue-tsc を含む）・`eslint`（scs・pdf）— 通過
- 実採取の 2 件（DSPLIBL の SBCS・DBCS）を復号し直し: decor は付かない＝従来の帳票は 1 文字も変わらない
- 変異: 29 通り。21 が初回から KILLED、8 が SURVIVED（全角が半角 2 字を消す・半分の幅の全角・縦線の溜めを空にする・同じ位置の縦線・ページをまたぐ縦線・奇数長・横罫線の幅・二重線の太さ）→ テストを足して全て KILLED。`flushPage` の「罫線だけの行を含める」は `addH`・`flushV` が `maxRow` を上げていて到達しない死んだ処理だったので消した

## 受け入れ基準ごとの判定
- AC1: pass — 重ね打ち 8 件（半角・二度打ち・三度打ち・空白・全角・全角が半角 2 字の上・行ごと・decor 無し）
- AC2: pass — DGL 12 件（縦線の溜めと行の変わり・ページで捨てる・消す 2 通り・種類 6＋不正・両方・SCD・不正な長さ・同じ位置・奇数長・罫線だけのページ）
- AC3: pass — 半分の幅 4 件（半桁刻み・戻った字・全角・空白）
- AC4: pass — 配布 HTML 5 件・画面 3 件・PDF 1 件

## 失敗の証跡
このラウンドでは失敗が発生していない（単体は初回で通った。`scs.test.ts` の 1 件は意図した変更〔半分の幅は層へ〕に合わせて直した。変異の生き残りはテストを足して殺した）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- **実機のホストがこれらの形の SCS を出すかは未確認**（実採取の 2 件には無い）。ACS の描き方は原典（JPS）の読みで決めた——実機の ACS の紙・PDF との突き合わせはしていない
- 縦線の縦の長さは、行送りが行ごとに違う帳票（SSLD）で ACS とずれうる（decisions D4）
- 画面・配布 HTML の見た目（ブラウザでの重なり方）は目で確かめていない。CSS の値は単体で固定した
