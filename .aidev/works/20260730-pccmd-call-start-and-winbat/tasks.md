# タスク: Windows 実機で見つかった 2 件を直す

- [x] T1: `start.bat` に `--auto-secret-key`（`start.sh` と同じ位置・趣旨のコメント付き）
- [x] T2: `pc-command.ts` に `stripCallBeforeStart()`（分かっていない事・効かなかった手も書く）
- [x] T3: `pc-command.ts` の `runPcCommand` で適用（`isAllowed` の後）＋ `detached: true`（依存: T2）
- [x] T4: `packages/server/test/pc-command.test.ts` に回帰テスト（境界・順序）（依存: T3）
- [x] T5: 既存テスト・`tsc -b`・lint（依存: T4）
- [x] T6: 空振り検証（依存: T5）
- [x] T7: 文書 — backlog に結論、`decisions.md`（依存: T6）
