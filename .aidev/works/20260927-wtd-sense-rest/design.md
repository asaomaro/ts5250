# 仕様: WTD の中の否定応答・受理の残り

## 依拠する既存の事実
- WTD の中の誤りは `fail()` で否定応答にし CC2 は効かせ、文字の並びが画面を越えるときは `"abort"` で CC2 まで落とす（`wtd-applier.ts`。`20260927-wtd-order-sense`・`20260927-ea-acs`）

## インターフェース / データ構造
- `applySf` は否定応答のときセンスを返す（`number | { sense, why }`）
- `fieldAddFailure`（wtd-applier.ts）・`ScreenBuffer.continuedSegment`・`updateFieldFfw`・`fieldCount`
- `SENSE.FIELD_ADD`（0x10050125）・`SENSE.FIELD_ATTRIBUTE`（0x10050130）

## 受け入れ基準との対応
- AC1: SBA 1,0 → 番地 -1、SF は番地 -1 の属性を置かずに欄を 0 から。FFW は 0x40 以上
- AC2: TD の長さが画面の残りを越えたら `"abort"`（文字の並びと同じ）
- AC3: `fieldAddFailure` と `invalidSfAttribute`。同じ位置の欄は `updateFieldFfw`
- AC4: DLTPGM・IFS の削除・tap のログの shred
