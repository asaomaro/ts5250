# タスク: 3270 エミュレータ（親 = subtask のフローリスト）

> 親 work は subtask 分割を採ったため、ここは**子 subtask の進行**を追う。
> 各 subtask の詳細タスクは `works/20260815-tn3270-emulator/<NN>-<subslug>/tasks.md`。

- [x] T1: `01-foundation-telnet` — 骨組み・ガード・telnet 交渉（TK4- と交渉成立）
- [x] T2: `02-datastream-inbound` — パーサ・バッファ・snapshot（s3270 と同内容で読める）（依存: T1）
- [x] T3: `03-input-outbound` — フィールド・MDT・AID・Read Modified（TSO まで往復）（依存: T2）
- [x] T4: `04-dbcs` — DBCS 導出・mini3270 ハーネス・s3270 照合（依存: T2）
- [x] T5: `05-trace-fixtures` — trace/replay・fixture 還元・decisions 記録（依存: T3, T4）
