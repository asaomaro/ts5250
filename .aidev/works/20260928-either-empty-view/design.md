# 仕様: 全角の状態の E・J の欄のカーソルの桁と End を ACS と同じにする

## 概要
全角の状態の E のうち full・open の形（`jeShapeOf`。`20260928-je-field-shape`）は空きを全角空白で埋め、列ビューの先頭に SO の桁を立てる。末尾の全角空白は詰め物として落とす。
End は J と full・open の E で全角空白も飛ばす。compact の E は SI を中身の直後に見せるので半角空白のまま。

## 設計方針
- 形ごとに詰め物を分ける `jeWidePad(f, chars)` を足す（J・G は従来の `wideFill`）。compact まで全角にすると SI が欄の最後へ動いて見える
- `end` に空きの判定を渡す引数を足す（既定は半角空白だけ）

## 依拠する既存の事実
- 列ビューは論理値と詰め物から組む（`fieldValidate.ts` の `dbcsViewLayout`・`ScreenGrid.vue` の `dbcsLayoutOf`）
- 送る値は full の NUL の組を `40 40` で送る（`jeExplicit`・`20260928-je-field-shape`）——full の末尾の全角空白を落としてもバイト列は同じ
- 空の E の `0e` はコアが置く（`20260927-either-field-so`）

## 振る舞いの詳細
- `padDbcs`: `wideFill(f) || jeWidePad(f, chars)` なら全角空白で詰める
- `trimPad`: 同じ条件で全角空白も落とす（compact の E の全角空白は中身）
- End: 同じ条件で `end(edit, 0, 半角か全角の空白)`

## 受け入れ基準との対応
- AC1: `packages/web-ui/test/either-empty-view.test.ts`（空にした E 3 件・End 5 件・compact の全角空白 1 件）。入力は ACS の測定（research F1・F2）
- AC2: `scripts/verify-browser-either-empty-view.mjs`（DSM の JEEDIT で End の 6 通りのカーソル＋`[J1]` のバイト列）
