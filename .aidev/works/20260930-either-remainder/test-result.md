# テスト結果: E 欄の残り

## 実行したもの
- `packages/web-ui` `npx vitest run`（パッケージ dir から） — 3024 passed / 0 failed（新規 `either-remainder.test.ts` 13 件を含む）
- `npm run build -w @ts5250/web-ui`（vue-tsc・test の型検査を含む）— 通過
- 実機（`node --env-file=.env --env-file=.env.verify scripts/verify-browser-either-remainder.mjs`）— pass=4 fail=0（X1 伏せ字・X2 Dup・X3 満杯への挿入・I1 挿入の余地が実機の ACS のコアと一致）
- 実機の修正前: X1・X2・I1 が不一致（X1 `40c1`、X2 0x1C が 7 個、I1 で全角の挿入が通って SI が最後の桁へ）
- 変異: 8 通り。6 が初回から KILLED、2 が SURVIVED（full の形の判定・貼り付けの余地）→ ちょうど 2 バイト空いた full の欄のテストと、改行つきの貼り付け経路のテストを足して両方 KILLED
- core（tn5250・server・hostserver）は触っていないので流していない

## 受け入れ基準ごとの判定
- AC1: pass — 伏せ字の E: 全角は full の形で届く・DOM に実値が出ない・混在は断る（`either-remainder.test.ts`、実機 X1）
- AC2: pass — Dup 8 個（DBCS の状態）・12 個（空の半角）（`either-remainder.test.ts`、実機 X2）
- AC3: pass — compact の E の余地なし・余地あり・full の従来どおり・貼り付け 2 経路（`either-remainder.test.ts`、実機 I1）
- AC4: pass — 実機 4 巡

## 失敗の証跡
このラウンドでは失敗が発生していない（テストは初回で通った。実機の修正前の不一致は上に記録。変異の生き残りはテストを足して殺した）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 伏せ字で中身が入って届く DBCS 欄の編集は ACS と違う（値をブラウザへ出さない設計。台帳に残す）
- IME の合成経路（`onCompositionStart`）の伏せ字の許可は単体で固定していない（実機は IME の CDP 入力で通った）
