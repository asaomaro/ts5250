# 調査: 透過の欄

## 調査の問い
- Q1: ACS は FCW 0x84xx をどう読み、どう送るか
- Q2: 実機の ACS のワイヤは原典どおりか
- Q3: 当 PJ はどうしているか

## 判明した事実
- F1（原典）: `Field5250` は FCW の上位バイトで振り分け、0x84 なら `transparentField = true`（下位バイトは見ない。0x80 は再順序付け、0x86 は継続欄、0x88 はカーソル送り）。
  `DS5250.sendAll` は READ MDT 系（7・9・82・130・131）で透過の欄を `0x11 行 桁 0x10 長さ(2) 生バイト`（`getFieldContents` の全桁。ヌルも落とさない）、
  READ INPUT 系（6・66・114）で生バイト（ヌルを 0x40 に換えない）で送る。定数 `TransparentData = 16`
- F2（実機・ACS のコア。`scripts/acs-probe/transparent-field.txt`・DSM の TRANSP）: (5,10) 透過の 8 桁 `AB`＋X、(7,10) 素の 6 桁 `CD`＋Y を READ MDT で
  `11050a100008c1c2e7000000000011070ac3c4e8`。DSM の欄の種類は type=2（ホストも透過のデータとして受けた）。READ INPUT の 2 回目は DSM 側が CPFA306 で待たずに終わり測れなかった
- F3（当 PJ）: `wtd-applier.ts` の `applySf` は 0x84xx を読み飛ばし、`read-response.ts` は普通の欄として末尾のヌルを落とす

## 実装アンカー
- A1: `packages/tn5250/src/protocol/wtd-applier.ts` `applySf` の FCW の分岐
- A2: `packages/tn5250/src/screen/buffer.ts` `InternalField`・`addField`
- A3: `packages/tn5250/src/protocol/read-response.ts` `buildFieldResponse`・`buildFlatFieldResponse`
