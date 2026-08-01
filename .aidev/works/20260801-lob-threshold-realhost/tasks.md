# タスク: LOB フィールドしきい値を使えるようにする

- [x] T1: `DbConnectOptions.lobFieldThreshold` と `clampLobThreshold`（既定 0・上限 15,728,640・
      非有限は 0 へ倒す）を足し、`setServerAttributes` に通す
- [x] T2: `scripts/research-lob-threshold.mjs` を書き、実機で型コード・並び・往復・
      バイト数を測る（依存: T1）
- [x] T3: `db-types.ts` の `SUPPORTED` に `CLOB` / `DBCLOB` / `BLOB` を足す
      （ロケーター型 960/964/968 は対象外のまま）（依存: T2）
- [x] T4: `db-decode.ts` にインライン LOB の復号を足す（4 バイト接頭辞・`inlineLob` で
      `LobPlaceholder` に包む）（依存: T3）
- [x] T5: **全角で測り直し**、DBCLOB の接頭辞が文字数であることを反映する（依存: T4）
- [x] T6: 単体テスト 2 本——`db-decode-inline-lob.test.ts`（並び）と
      `db-connection-lob-threshold.test.ts`（丸めの境界）（依存: T5）
- [x] T7: 既存の「LOB 型は対象外」テスト 2 件を実態に合わせる（依存: T3）
- [x] T8: `npm run build` / `npm run lint` / `npm test`（依存: T1〜T7）
