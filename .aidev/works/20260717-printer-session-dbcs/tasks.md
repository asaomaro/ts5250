# タスク: プリンター DBCS 対応
- [x] D1: ScsDecoder に SO/SI シフト＋DBCS 全角（2 桁・継続桁）対応
- [x] D2: 実機 DBCS スプール採取（CHGLIB 日本語→DSPLIBL *PRINT）→ golden fixture
- [x] D3: 合成往復テスト（SO/SI 枠）＋実採取 golden テスト
- [x] D4: 実機検証 verify-printer-dbcs.mjs（CCSID 1399・5 項目）
- [x] D5: terminalTypeFor 注記（IBM-3812-1 で DBCS も可）・README/scripts 更新
