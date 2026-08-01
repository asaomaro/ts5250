# タスク: attach と帳票バッファの上限

- [x] T1: `REPORT_LIMIT`（50）と `receivedTotal` を入れ、落としたら `delivered` もずらす
- [x] T2: `PrinterEntry.ref` を持たせ、`openPrinter` で `ref` ＋ `owner` の attach 判定（依存: T1）
- [x] T3: ws-handler で `ref` と `autoStart` を渡す（依存: T2）
- [x] T4: `printer-opened` にバッファ済みの帳票と `receivedTotal` を載せる（依存: T1,T3）
- [x] T5: テスト（attach 4 件・上限 3 件）（依存: T1〜T4）
- [x] T6: 実機で「二度開いても 1 本」を確認（依存: T5）
- [x] T7: `npm run build` / `npm run lint` / `npm test`
