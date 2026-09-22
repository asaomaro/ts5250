# 調査: SCS の制御（ACS との突き合わせ）

## 判明した事実
- F1（原典 `PrintSCS5250` のコンストラクタ）: 0x00〜0x3F の既定は `UndefinedControl`（1 バイト読み飛ばし・警告だけ）、0x40〜0xFF は印字文字。
  割り当て: 0x16 BS・0x2F BEL・0x0D CR・0x0C FF・0x05 HT・0x25 LF・0x36 NBS・0x39 IT・0x33 IR・0x34 PP・0x3A RFF・0x06 RNL・0x38 SBS・0x09 SPS・
  0x15 / 0x1E NL・0x00 / 0x14 / 0x24 / 0x23 Null・0x08 GE・0x28xx SA・0x35 TRN・0x0B VT・0x04 VCS・0x03 ATRN（ASCII 透過）・
  2B C8 SGEA・2B D3 STO・2B D1 フォント選択・2B C1 SHF・2B C6 SLD・2B D2・2B C2 SVF・2B FD・2B FE。
- F2（原典の各処理）: NBS・IT・IR・RFF・RNL・SBS・SPS は `processUnsupportedControl`（警告だけ・1 バイト）。LF は `process_crlf(2)`（行だけ進む）、
  NL は `process_crlf(3)`。VT は垂直タブ位置へ、無ければ LF。BS は 1 桁戻る。GE は 2 バイトでグラフィック・エラー文字（既定 96＝0x60）を置く。
  SA は 3 バイト、VCS は 2 バイト。TRN・ATRN は長さ＋本体（TRN は TPO なら生で、でなければ 0x40 未満を 0x40 にして印字。ATRN はプリンターへ生で）。
  2B のクラスは SGEA が 5 バイト固定、ほかは**クラスの次のバイト＋2**。**表に無いクラスは `proc_undefcode`（1 バイト）**——長さで読み飛ばすのではない
  （台帳の「ACS は長さの前置を見て汎用に読み飛ばす」は、表にあるクラスについてだけ正しい）。
- F3（当 PJ）: `packages/scs/src/scs.ts` は tn5250 の表で、0x03 を EBCDIC の透過・RNL を改行・RFF を改ページとし、それ以外は印字。
  2B C1/C2/C6 は長さがあれば 1 バイトだけ、D1 はサブごとの固定長（06 は 6 バイトで、長さ 06 の 8 バイトと食い違う）、FE と表に無いクラスは打ち切り。
- F4（実機）: 日本語機の DSPLIBL の帳票は `2B D1 03 81 FF` の直後に **SBCS の状態の SI（0x0F）** があり、当 PJ はそれを桁に置いて「�」を出していた。
  PUB400 の実採取の帳票 2 件（`packages/scs/test/fixtures`）は新旧の復号で 1 桁も変わらない。

## 実装アンカー
- A1: `packages/scs/src/scs.ts` の `decode` の振り分けと `skip2b`

## 独立点検の後の訂正（2026-09-21）

- F5（原典 `PD5250.getPrintHostDataIndex`）: ACS の SCS の読み方は 1 つではない——HPT なら変換済み、`jpsUse`（既定 true）なら
  **Java 印刷（JPS）経路 `PrintSCS5250JPS`**、そうでなければ PDT 経路（`PrintSCS5250` / DBCS は `PrintSCS5250DB`）。`usePDT` の既定は
  Windows で false・それ以外で true（`HODDefaults`）。利用者の ACS は Windows なので、**HPT を外した 5250 プリンターの既定は JPS**。
  ~~F1・F2 は ACS の読み方~~ は PDT 経路についての事実で、既定の経路ではなかった（独立点検の指摘）。
- F6（原典 `PrintSCS5250JPS`）: 表は PDT と違う。0x0A RPT・0x14 ENP・0x1A UBS・0x23 WUS・0x24 INP・0x2A SW・0x3F SUB は 1 バイト読むだけ、
  0x0E / 0x0F は**状態に関わらず** SO / SI、2B は C1・C2・C6・**C8**・**CA**・D1・D2・D3・**D4**・FD・FE を「長さ＋2」で読み、表に無いクラスは
  1 バイト（PDT と同じ）。働き: BS は何もしない、GE は何も置かない、VCS は何もしない、HT は空白 1 つ（`JPSHorizontalTab extends JPSSpace`）、
  VT は LF、TRN の本体は 1 バイトごとに 0x40 なら空白・ほかは `-`（代替文字を読み込んでいればその字）、SO / SI は空白を書かずに位置を進める
  （`JPSShiftOut` / `JPSShiftIn` の `setX`）。SA の `28 43 F8` / `28 43 00` による DBCS の切り替えは PDT の DB だけにあり、JPS には無い。
