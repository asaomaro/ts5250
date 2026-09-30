# 仕様: 割れた全角の半分

## 概要
継続した O 欄の値に「区間の間で割れた全角の前半・後半」を 1 文字ずつ持たせ、詰め直しが前半を区間の最後の桁へ置いて後半を次の区間の頭へ置く。core はそれを前半セル・後半セルとして置き、送信は連結で 2 バイトになる。

## 設計方針
- 値の文字: 前半 = 第 16 面の `0x100000 + 字`、後半 = 第 15 面の先頭。センチネル（U+DC00〜）・通常の字と重ならず、幅は 1
- 詰め直しは既存の `take()`（前半を置き、区間を終える。次のトークン＝後半は次の区間の頭に置かれる）

## 対象範囲
- `packages/tn5250/src/screen/{attr-sentinel,buffer,field-validate}.ts`・`session/session.ts`・`browser.ts`
- `packages/web-ui/src/composables/{oChainCells,oFieldCells,fieldValidate}.ts`・`components/ScreenGrid.vue`

## 依拠する既存の事実
- 符号化は全区間の連結（`read-response.ts` の `rawDbcsSendValue`）。前半のセルの字と後半の空のセルを連結すれば 2 バイトになる
- `reflow` の `budget` と `left` で区間の最後の桁を判定できる（`oChainCells.ts`）
- 値の往復は `toCells`・`fromCells`（`oFieldCells.ts`）

## インターフェース / データ構造
- `splitLead(ch)`・`isSplitLead`・`splitLeadChar`・`SPLIT_TAIL`・`isSplitTail`（`attr-sentinel.ts`。browser サブパスへ再輸出）
- `fromCells`: 区間の最後の前半は `splitLead`、区間の頭の後半は `SPLIT_TAIL`（それ以外の孤立した半分は従来どおり空白）

## 振る舞いの詳細
- 挿入: 前半を区間の最後の桁へ置いて終え、並びは閉じない。後半は次の区間の頭
- core の置き方: 前半 = `dbcs-lead` セル 1 つ（字を持つ）、後半 = `dbcs-tail` セル 1 つ（以降その区間は並びの中）
- 検証: 前半は字として型・コードページを検査し、後半は目印として外す。桁数の検査（バイト長）は割れた半分を含む値では行わない（`setFieldValue` のセルの数が越えれば FIELD_OVERFLOW）
- `normalizeO`: 鎖の区間は、頭が SI・全角・割れた後半なら並びの中から始まり、割れた前半で終わる（直さない）

## エラー処理 / 異常系
- 字が BMP 外なら割れた前半は作れず、従来どおり 0012

## 受け入れ基準との対応
- AC1: 実機 `verify-browser-cont-o-last-lead.mjs`・`o-chain-cells.test.ts`・`o-chain-send.test.ts`・`split-char-session.test.ts`
- AC2: `o-chain-send.test.ts`（書き直しで消える・型検証）・`o-chain-edit.test.ts`
