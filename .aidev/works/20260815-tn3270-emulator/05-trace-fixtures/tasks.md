# タスク: 05-trace-fixtures

- [x] T1: `trace/trace.ts`（送受信バイトの記録。JSONL 形式）
- [x] T2: `trace/replay.ts`（`ReplayTransport`。記録を再生する Transport 実装）（依存: T1）
- [x] T3: DBCS の fixture を採取して保存（照合済みのバイト列を回帰資産に）（依存: T2）
- [x] T4: replay の単体テスト（docker 不要で画面が組み上がること）（依存: T2, T3）
- [x] T5: 入口（`index.ts` / `browser.ts`）に公開面を追加（依存: T2）
- [x] T6: `decisions.md` に D2 / D4 / D5 / D7 と、実測で覆した判断を記録
