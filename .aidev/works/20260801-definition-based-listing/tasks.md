# タスク: 定義ベースの一覧

- [x] T1: `PublicSession` に `autoStart` / `service` / `hasOutput` を足す
- [x] T2: `publicSession` で埋める（**フラグだけ**。`autoPdfDir` のパス・`autoPrint` の名前は出さない）（依存: T1）
- [x] T3: `host-printers.ts` を定義ベースに作り直す（依存: T2）
- [x] T4: `GET /api/watches` を同じ形で新設する（依存: T3）
- [x] T5: ルート登録に `resolver` と `watches` を渡す（依存: T4）
- [x] T6: テストを作り直す（11 件）（依存: T5）
- [x] T7: `npm run build` / `npm run lint` / `npm test`
