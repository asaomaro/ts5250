# タスク: SAVE PARTIAL SCREEN に応答し、QSH を通す

- [x] T1: `constants.ts` に `SAVE_PARTIAL_SCREEN` / `RESTORE_PARTIAL_SCREEN`
- [x] T2: `wtd-applier.ts` に `0x03` / `0x13` / `0x23` の分岐（依存: T1）
- [x] T3: `save-screen.ts` に応答（直列化を共有）（依存: T1）
- [x] T4: `buffer.ts` に `roll()`（依存: なし）
- [x] T5: `session.ts` で応答を送る（依存: T3）
- [x] T6: 単体テスト（応答の形・**後続が生き残る**・ROLL の境界）（依存: T5）
- [x] T7: 実ブラウザ＋実機の回帰 `scripts/verify-browser-qsh.mjs`（依存: T6）
- [x] T8: 空振り検証（依存: T7）
- [x] T9: 文書 — `docs/PROTOCOL.md`・backlog・`decisions.md`（依存: T8）
