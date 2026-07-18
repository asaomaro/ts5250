# タスク: コマンドサーバー経由の CL 実行とプログラム呼び出し

- [x] T1: `command/command-datastream.ts` — サーバー ID・要求 ID・CP の定義、要求の組み立て（交換属性・コマンド実行・プログラム呼び出し）。単体テスト付き
- [x] T3: `command/command-message.ts` に重大度の分類（0=info / 1-19=warning / 20-39=error / 40+=severe）。単体テスト付き
- [x] T2: `command/command-message.ts` — メッセージ解析（CP 0x1106 実機バイト列 / CP 0x1102 合成）。単体テスト付き（依存: T3）
- [x] T4: `command/command-connection.ts` — 接続・**交換属性を手順に組み込む**・レベル 10 未満の明示的失敗（依存: T1,T2）
- [x] T5: コマンド実行（`run` / `runOrThrow`）と `CommandError`。成否は戻りコードで判断（依存: T4）
- [x] T6: プログラム呼び出し（`call`）と出力パラメータの受け取り（依存: T5）
- [x] T7: `index.ts` に公開 API を追加（依存: T6）
- [x] T8: 実機検証 — 安全なコマンド 4 種、TLS/平文、プログラム呼び出し、資格情報の非漏洩（依存: T7）
