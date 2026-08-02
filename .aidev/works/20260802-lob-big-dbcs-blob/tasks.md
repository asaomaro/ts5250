# タスク: 純 DBCS と BLOB の 64KB 超を実測で閉じる

- [x] T1: 実機で事実を採る（`research-lob-big-dbcs-blob.mjs`）
- [x] T2: `isBinaryCcsid` を `db-decode.ts` に置き、`decodeLobBytes` /
      `db-reply.ts` / `marker-encode.ts` の 3 か所を寄せる（依存: T1）
- [x] T3: 回帰テスト——`isBinaryCcsid`・65535 の復号・純 DBCS/BLOB の分割
      （**偽ホストの perChar は引数で渡す**。循環を避ける）（依存: T2）
- [x] T4: `verify-lob-big-dbcs-blob.mjs` で実機確認（依存: T3）
- [x] T5: `scripts/README.md` ＋ `npm run build` / `npm run lint` / `npm test`（依存: T4）
