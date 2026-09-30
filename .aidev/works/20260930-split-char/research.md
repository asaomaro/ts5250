# 調査: 区間の最後の桁の SI の上の全角の挿入

## 判明した事実
- F1（実機。`scripts/acs-probe/cont-o-last-lead.txt`・DSM の CONTOX・2026-09-28）: C12 の形（先頭 `SO い き く SI`）の SI（5,17）へ全角 あ を挿入すると、ホストは `0e 4482 4487 4488 4481 4484 0f e7 40 e8 e9` を受け取り、カーソルは 6,11。画面は半角カナに崩れる（ACS も）
- F2（コード）: 当 PJ の詰め直し（`oChainCells.ts` の `reflow`）は、前半が区間の最後の桁に来る形を 0012 で止めていた。値は区間ごとの文字列で、1 字を 2 つの区間に割って持つ表し方が無かった
- F3（コード）: 符号化は区間ごとではなく全区間の連結（`read-response.ts` の `rawDbcsSendValue`）。前半のセルは字を持ち、後半のセルは空なので、連結すると 2 バイトに符号化される
- F4（実機のブラウザ・最初の走行）: 値の検証 `validateFieldContent` が割れた半分を字として符号化できず FIELD_TYPE、桁数の検査 `encodedFieldLength` が区間ごとの符号化で FIELD_OVERFLOW になった

## 影響範囲
- core: `attr-sentinel.ts`・`buffer.ts`・`field-validate.ts`・`session.ts`、web-ui: `oChainCells.ts`・`oFieldCells.ts`・`fieldValidate.ts`・`ScreenGrid.vue`

## 実装アンカー
- A1: `oChainCells.ts` `reflow` の `left === 1`
- A2: `attr-sentinel.ts`（割れた半分の値の表し方）・`buffer.ts` `setFieldCells`

## design への申し送り
- 前半は字を運ぶ（第 16 面＋字）、後半は目印（第 15 面の先頭）。どちらも桁は 1 つ
- 検証は前半を字として・後半を外す。桁数の検査は割れた半分を含む値ではセルの数に任せる
