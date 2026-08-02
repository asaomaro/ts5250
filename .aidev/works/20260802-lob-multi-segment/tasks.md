# タスク: LOB の分割受信をホストの単位（文字）で回す

- [x] T1: **文字で数える偽ホスト**を書く（`conn.request` だけ作る。要求を記録して
      `lobStartOffset` / `lobRequestedSize` を検査できるようにする）
- [x] T2: **落ちるテスト**——2 バイト CCSID・2 セグメントで**中抜け**を検出する（依存: T1）
- [x] T3: `retrieveLob` のループを文字単位へ。`SEGMENT_BYTES` → `SEGMENT_UNITS` に改名
      （**名前が単位を偽っていた**のが入口）。オフセットは**届いたバイト数から割る**（依存: T2）
- [x] T4: 上限への切り詰め（`perChar` の倍数・**孤立サロゲートを残さない**）（依存: T3）
- [x] T5: SBCS / 混在の回帰——往復も結果も従来どおり（依存: T3）
- [x] T6: `scripts/verify-lob-multi-segment.mjs` で実機確認（依存: T4,T5）
- [x] T7: `scripts/README.md` に research / verify を追記 ＋
      `npm run build` / `npm run lint` / `npm test`（依存: T6）
