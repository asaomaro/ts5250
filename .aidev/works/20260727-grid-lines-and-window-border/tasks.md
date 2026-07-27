# タスク: DSPF の罫線を描く

- [x] **T1**: 原典（Wireshark 5250 ディセクタ）を直読して構造を確定（報告書の 10→13 バイト誤りを発見）
- [x] **T2**: パーサ（WDSF 0x60/0x61・CREATE WINDOW の Border Presentation）
- [x] **T3**: 状態保持（ScreenBuffer の gridLines・窓の border・退避/復元）
- [x] **T4**: 描画（グリッド線の辺展開・線種 CSS・ホスト指定枠）
- [x] **T5**: 実機（）で DSPF をコンパイルして表示確認 → **可変長の取りこぼしを 2 件発見して修正**
- [x] **T6**: 通し確認（build / test / lint / vue-tsc）
