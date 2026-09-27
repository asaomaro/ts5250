# 調査: WDSF の頭の検査

## 判明した事実
- F1: ACS `ENPTUI5250.processWSFOrder`: 残りが 4 バイトに足りない → 0x10050121、LL < 4 → 0x10050110、クラス ≠ 0xD9 → 0x10050111、型が 0x50〜0x55・0x58・0x59・0x5B・0x5F・0x60・0x61 以外 → 0x10050111。`DS5250.processWriteToDisplay` は否定応答で WTD を打ち切る
- F2: 実機の ACS のコア（DSM の WTDERRWDSF*・tap）: ENPTUI 有効では LL=3 → 0x10050110、クラス 0xD8・型 0x7F → 0x10050111（NEXT は書かず mw は点く）。中身の無い 0x55 は 0x10050110（構造体の中身の検査）。ENPTUI 無効では WDSF を読み飛ばして否定応答しない
- F3: 当 PJ は ENPTUI を常に申告する（`query-reply.ts` の「拡張は常に広告する」）
- F4: 直す前の当 PJ: 長さの誤りはレコードの残りを捨て、知らないクラス・型は警告して読み飛ばす（`wtd-applier.ts` の `applyWdsf`）

## 実装アンカー
- A1: `packages/tn5250/src/protocol/wtd-applier.ts` `applyWdsf`・`SENSE`
