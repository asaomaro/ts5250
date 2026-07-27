# タスク: コマンドサーバーの交換属性で「警告」の戻りコードを致命扱いしない

- [x] **T1**: 原典（JTOpen `archived/jtopenlite/.../CommandConnection.java`）を直読し、6 件の一致を確認
- [x] **T2**: 落ちるテストを書く（0x0106 / 0x0100 の許容、rc=0 の warning undefined）
- [x] **T3**: 差分を取り込む（`command-datastream.ts` / `command-connection.ts`）
- [x] **T4**: 通し確認（build / test / lint）＋ 実機で回帰が無いこと
