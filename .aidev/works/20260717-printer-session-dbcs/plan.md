# 計画: プリンター DBCS 対応

## 実装方針
core の ScsDecoder のみで完結（server/web-ui は Unicode をそのまま扱うため変更不要）。
## 作業順序
1. ScsDecoder に SO/SI＋全角 2 桁対応。2. 実機 DBCS スプール採取→golden。3. 合成往復テスト。
4. 実機 verify。5. 端末タイプ注記・docs。
## テスト方針
golden（実採取）＋合成往復（SO/SI 枠）＋実機 verify。SBCS 経路の不変（回帰なし）を全テストで担保。
