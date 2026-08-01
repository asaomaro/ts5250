# タスク: LOB ロケーターの解放

- [x] T1: `DB_REQ.freeLob = 0x1819` と `freeLob(conn, locator)` を実装する（投げない・戻りは boolean）
- [x] T2: `index.ts` から `freeLob` を公開する（依存: T1）
- [x] T3: `scripts/research-lob-free.mjs` で実機の 4 点を測る
      （解放が効くか / 二重解放 / 別接続 / 番号の配り直し）（依存: T2）
- [x] T4: 実測に合わせて「既に解放済み」の戻りコードを直す（原典は `7/-401`・実機は `2/-816`）（依存: T3）
- [x] T5: 単体テスト `lob-free.test.ts`（要求の形・戻りの扱い）（依存: T4）
- [x] T6: `npm run build` / `npm run lint` / `npm test`（依存: T1〜T5）
