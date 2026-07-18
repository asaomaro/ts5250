# タスク: スプールファイルの一覧・取得

- [x] T1: `spool/spool-types.ts` — `SpoolId` / `SpoolEntry` / フィルタの型
- [x] T2: `spool/spool-list.ts` に OSPF0100 フィルタの組み立て（連続配置・各配列最低 1 件）。単体テスト付き（依存: T1）
- [x] T3: 一覧レコード（OSPL0300・136 バイト）の解析。**配置は原典で確定**。実機バイト列の単体テスト付き（依存: T2）
- [x] T4: `listSpooledFiles()` — QGYOLSPL 呼び出しと結果の組み立て（依存: T3）
- [x] T5: `spool/netprint-datastream.ts` — 20+12+LL/CP のヘッダーと操作コード。単体テスト付き（依存: T1）
- [x] T6: `spool/netprint-connection.ts` — 接続・認証（サーバー ID 0xE003）（依存: T5）
- [x] T7: 中身取得（OPEN→READ→CLOSE）。**OPEN が通るかを先に実機で確かめてから通しを書く**（依存: T6）
- [x] T8: `index.ts` に公開 API を追加（依存: T4,T7）
- [x] T9: 実機検証 — 一覧・中身・**SQL との突き合わせ**・識別子の連携（依存: T8）
