# タスク: MCP の排他

- [x] T1: `SessionEntry.viewers` と `hasViewer` / `addViewer` / `removeViewer`
- [x] T2: 予約が期限を持つ（`reserve(..., ttlMs?)`、`touchReservation` が使う）
- [x] T3: `ws-handler` が在席を付け外しする（依存: T1）
- [x] T4: MCP の書き込み 8 箇所で `claimForWrite`（依存: T1,T2）
- [x] T5: 足し忘れをソース走査で固定する検査（依存: T4）
- [x] T6: `list_sessions` に `reservedBy`（依存: T1）
- [x] T7: 実機で MCP 用期限を実測し、値を決める（依存: T3,T4）
- [x] T8: E2E を拡張して覆いの出入りを目視（依存: T7）
