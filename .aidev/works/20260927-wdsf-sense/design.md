# 仕様: WDSF の頭の検査

## 依拠する既存の事実
- WTD の中の誤りは `fail()` で否定応答にし CC2 は効かせる（`wtd-applier.ts`）

## 受け入れ基準との対応
- AC1: `applyWdsf` がセンスを返し、呼び出し側が `fail()` する。`SENSE.WDSF_LENGTH`・`SENSE.WDSF_CLASS`
- AC2: ACS が受ける型の集合（`WDSF_KNOWN_TYPES`）。LL がレコードを越える形は従来どおり（ACS は例外で戻る）
