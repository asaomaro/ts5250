# タスク: 常駐プリンターが受け取った帳票を画面から読めるようにする

- [x] T1: `StoredReport` を置き、`deliverReport` が `this.now()` で `receivedAt` を刻む。
      **push・出力・配列は同じ 1 個**を使う（`onReport` の型も変える）
- [x] T2: `ws-messages.ts` の `printer-opened.reports[]` と `report.report` に
      `receivedAt?: number` を足す（**任意**＝後方互換）（依存: T1）
- [x] T3: `ws-handler.ts` が両電文に `receivedAt` を載せる（依存: T2）
- [x] T4: `session-controller.ts` の `printer-opened` が `msg.reports` /
      `msg.receivedTotal` を使う。先頭を選択、**未読は 0 のまま**。
      `report`（live）は `receivedAt` を素通しし `receivedTotal` を +1（依存: T3）
- [x] T5: `SessionState.receivedTotal` を足し、`PrinterPane` の件数を
      `受信 N 件（保持 M）`（同値なら括弧なし）にする（依存: T4）
- [x] T6: `composables/openConfigured.ts` を新設し、`LauncherPane.connect()` を委譲。
      `meta.host` は**そのセッション自身のシステム**から引く
- [x] T7: `ServicesPane` のプリンター行に `開く` を足す（`editable` で隠さない・
      定義が引けなければ出さない）（依存: T6）
- [x] T8: server テスト——`receivedAt` を刻む / 電文に載る / **live にも載る**（依存: T3）
- [x] T9: web-ui テスト——restore で一覧・選択・未読 0・累計 / `receivedAt` 無しでも壊れない /
      件数表示 / `開く`（開く・タブへ移る・出さない）（依存: T5,T7）
- [x] T10: `scripts/verify-printer-report-history.mjs`（WS を切って帳票を出し、
      開き直して読める）＋ `scripts/README.md` に追記（依存: T9）
- [x] T11: `npm run build` / `npm run lint` / `npm test`（web-ui は `vue-tsc` まで）（依存: T10）
