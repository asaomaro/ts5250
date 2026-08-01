# タスク: ロケーター経由の DBCLOB を直す

- [x] T1: 実機で生バイトを採り、申告長の単位を確定する（DBCLOB=文字数 / 混在 CLOB=バイト数）
- [x] T2: `db-decode.ts` に `isTwoByteCcsid` と `decodeLobBytes` を新設して公開する（依存: T1）
- [x] T3: `lob.ts` で申告長を CCSID に応じて換算する（`declaredTotal` を CCSID 判明後に `× perChar`）（依存: T2）
- [x] T4: `query.ts` のローカル `decodeLob` を削除し `decodeLobBytes` を使う（依存: T2）
- [x] T5: 実機で再検証し、**インライン経路にも回帰が無い**ことを確かめる（依存: T3,T4）
- [x] T6: 単体テスト `lob-ccsid-units.test.ts`（単位の判定・UTF-16/混在/BLOB/未知の復号）（依存: T5）
- [x] T7: `npm run build` / `npm run lint` / `npm test`（依存: T1〜T6）
