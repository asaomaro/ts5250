# タスク: プログラム呼び出し

- [x] T1: 詰め 10 進 / ゾーン 10 進の**書く向き**と往復の検査
- [x] T2: 型付き引数 ↔ `ProgramParameter`（依存: T1）
- [x] T3: `POST /api/host/program`（依存: T2）
- [x] T4: MCP `host_call_program`（依存: T2）
- [x] T5: web-ui の導線（依存: T3）
- [x] T6: 実機——`QCMDEXC` と出力の往復（依存: T3,T4）
