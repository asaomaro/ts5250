# 調査: DBCS プリンターの実現性（実機）

## 問いと事実
- Q1: DBCS プリンター接続に別端末型番（IBM-5553 系）が要るか？
  - **F1: 不要**。IBM-3812-1 のまま CCSID 1399 を KBDTYPE/CODEPAGE/CHARSET で申告すれば PUB400 実機で
    I902（Session successfully started）で接続でき、DBCS スプールも届く（推測でなく実機で確定）。
- Q2: DBCS スプールをどう生成・採取するか？
  - **F2**: 表示セッション（CCSID 1399）で `CHGLIB LIB(MYLIB) TEXT('日本語テスト')` → `DSPLIBL OUTPUT(*PRINT)`。
    受信 SCS 732B に SO(0x0E) を確認。採取物を golden fixture 化（`scs-print-dbcs.bin`）。
- Q3: SCS 内の DBCS 表現は？
  - **F3**: 5250 表示と同じく SO(0x0E)/SI(0x0F) で全角区間を囲み、区間内は 2 バイト＝全角 1 文字。
    tn5250 は SCS で DBCS 未対応のため自前実装（既存 DbcsCodec の decodeDbcsPair を利用）。

## spec への申し送り
- DBCS モードは制御コード値（0x0C/0x0D/0x15/0x2B/0x34）と衝突しうるため、制御 switch より前で
  2 バイトずつ消費する。全角は 2 桁を占め、後半桁は継続（空文字列）で桁揃えを保つ。
