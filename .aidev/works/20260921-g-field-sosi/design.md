# 設計

## 概要
- core: `nlsSegment`（WEA5 の 0x81 で始まり 0x80／0x00 で終わる）と `ScreenBuffer.isPureDbcsAt(addr)`（G の欄の中）で、`dbcsMode` と同じ 2 バイト組の読みを SO/SI 無しで行う。
  `writeValue(…, noShift)` は全角の連なりの SO/SI を外し、G の欄は欄長（偶数）いっぱいに 0x40 で詰めて切る。
- web-ui: `noShift(f)`（`dbcsType === "pure"`）を `byteLen`・`padDbcs`（全角空白で詰める）・列ビューの SO/SI マーク（空）・`trimPad`（全角空白も詰め物）・`dbcsByteLength(…, noShift)`・MF の `isFull` に通す。

## 対象範囲
- `packages/tn5250/src/protocol/wtd-applier.ts`・`read-response.ts`、`screen/buffer.ts`。`packages/web-ui/src/components/ScreenGrid.vue`・`composables/fieldValidate.ts`・`mandatoryCheck.ts`。試験画面: `scripts/build-gtest.mjs`・`host-src/gtst.c`・`diag-gfield.mjs`・`acs-probe/g-field.txt`。

## 依拠する既存の事実
- 欄の値は `ScreenBuffer.fieldValue`（未編集の DBCS 欄は生バイトのセンチネル）と `setFieldValue`（編集後は論理値）。DBCS 欄の編集の初期値はセル（`logicalFromCells`）から採られる。

## インターフェース / データ構造
- `ScreenBuffer.isPureDbcsAt(addr): boolean`・`writeValue(w, value, codec, noShift = false)`・`dbcsByteLength(value, session?, noShift = false)`・`soMark(f?)`/`siMark(f?)`・`trimPad(f, s)`。

## 振る舞いの詳細
- G の値は全角（と生バイトのセンチネル）だけ。送信は欄長＝偶数バイトの SO/SI 無し。編集の詰め物は全角空白で、値の末尾の全角空白と半角空白は落とす（コアが 0x4040 で詰めるので同じワイヤ）。

## エラー処理 / 異常系
- DBCS でないコードページの WEA5 は従来どおり警告して読み飛ばす。G に半角が混ざった値（API 経由）は従来の符号化で SO/SI が途中に入る（G には入らない値）。

## 受け入れ基準との対応
- AC1〜AC2: `dbcs-pure-field.test.ts`（tn5250。実機の WTD の生バイト）。AC3〜AC4: `dbcs-pure-field.test.ts`（web-ui）。AC5: mutation 20 通りと実機の当 PJ の送信の確認。
