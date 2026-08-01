# タスク: プリンターの常駐

- [x] T1: `PrinterEntry.resident` を足し、`openPrinter` が `opts.output` の有無で決める（design D1）
- [x] T2: `size` から常駐を除き、`maxResidentPrinters`（既定 4）を足す（design D3）（依存: T1）
- [x] T3: `sweepIdle` で常駐を飛ばす（依存: T1）
- [x] T4: `isResident()` を足し、`ws-handler.dispose()` が常駐を `close()` しないようにする（依存: T1）
- [x] T5: `GET /api/printers` を新設する（信頼設定の中身は出さない・所有で絞る・警告は新しい順）（design D2）（依存: T1）
- [x] T6: 単体テスト 2 本（`printer-residency` 9 件 / `host-printers` 5 件）（依存: T1〜T5）
- [x] T7: 実機で通しの確認（`scripts/verify-printer-residency.mjs`）（依存: T6）
- [x] T8: `npm run build` / `npm run lint` / `npm test`（依存: T1〜T7）
