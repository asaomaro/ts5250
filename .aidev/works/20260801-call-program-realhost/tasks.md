# タスク: host_call_program の実機検証

- [x] T1: 返り値を外部の事実と突き合わせられる読み取り専用 API を選ぶ（`QUSROBJD` / `QSYRUSRI`）
- [x] T2: 正しいパラメータ列で呼ぶスクリプトを書き、実機で通す（依存: T1）
- [x] T3: 出力の位置合わせ（要求順・入力位置は null）を確かめる（依存: T2）
- [x] T4: `npm run build` / `npm run lint` / `npm test`（依存: T2）
