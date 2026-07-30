# タスク: 0x13 の修正と、数えた結果の記録

- [x] T1: `scripts/census-5250-commands.mjs`（11 画面を巡ってコマンドを数える）
- [x] T2: `0x13` のパラメータ 5 バイトを読み飛ばす（依存: T1）
- [x] T3: 実機で警告が消えることを確認（依存: T2）
- [x] T4: 実機の形をテストで固定（依存: T2）
- [x] T5: 空振り検証（依存: T4）
- [x] T6: 文書 — backlog に結論、`scripts/README.md`、`decisions.md`（依存: T5）
