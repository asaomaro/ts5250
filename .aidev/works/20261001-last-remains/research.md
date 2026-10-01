# 調査: 最後の残り

## 判明した事実
- F1（実機。`open-e-typing.txt`・DSM の OPENE・2026-10-01）: compact の E を SO の次で Erase EOF してから打つと、`いう` → `0e 4482 0e 4483 0f`、`いうえ` → `0e 4482 0e 4483 4484 0f`、`い`＋Space → `0e 4482 0e 4040 0f`、先頭の Space＋`い` → `0e 4040 0e 4482 0f`、`いうえおか` → `0e 4482 0e 4483 4484 4485 0f`（か は入らない）。READ MDT・ALT とも同じ。ホストが `SO あ` と書いた open の E に い を足すと `SO あ い`（`je-field-shape.test.ts` の J3。1 つの並び）——Erase 後だけの振る舞い（消した欄の DBCSPlane が残る）
- F2（実機。`space-typed-2.txt`）: 通常の文字欄に `A B` を打って Backspace は `c1 40`
- F3（実機。`cont-o-split-edit.txt`・DSM の CONTOS・2026-10-01）: ホストが割れた形（先頭 `0e 4482 4487 4488 44`・中間 `81 4484 0f e7`）を書いた鎖で、先頭の最後の桁の Delete は `…4487 4481 4484 0f e7`、中間の頭の Delete・2 桁目の Backspace は `…4488 4444 84 0f e7`（**組が崩れた不正な DBCS**）、前半への A は `…4488 c1 81 4484…`（`c1` が前半を食い 81 が残る）、前半への う は欄を送らない（エラー）。ACS は区間をまたぐ 1 バイトずつを動かし、割れた字のバイトを別々に扱う
- F4（コード）: 当 PJ の通常の文字欄は詰め物が半角空白で、`sync` の送信値は末尾の空白を落とす。語送りの欄（`isWrapEdit`）は空きを NUL で持つ仕組みが既にある

## 影響範囲
- web-ui: `ScreenGrid.vue`（`byteLen`・`jeExplicit`・`jeErased`・`usesNulPad`・`trimPad`・`deleteSelection`）、`fieldEdit.ts` の `end`
- core: `field-validate.ts`

## 実装アンカー
- A1: `ScreenGrid.vue` `eraseToEndDbcs`（open にする）・`jeExplicit`・`byteLen`
- A2: `ScreenGrid.vue` `beginEdit`・`sync`・`usesNulPad`

## design への申し送り
- open の E: Erase で中身が全部消えたときだけ（残った中身が 1 つの並びで続く形は未測定）
- 通常の欄: 語送りの欄の NUL の仕組みを広げる。整形が空白を前提とする欄は除く
