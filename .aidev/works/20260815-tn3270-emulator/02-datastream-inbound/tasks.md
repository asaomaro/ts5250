# タスク: 02-datastream-inbound

- [x] T1: **フィールド属性ビットの割り当てを実測で確定する**（既知の属性バイトを流し `s3270 -trace` の復号を読む）
- [x] T2: `protocol/constants.ts`（コマンド・オーダー・WCC・属性ビット。T1 の実測を根拠に）（依存: T1）
- [x] T3: `protocol/address.ts`（12/14/16bit の符号化・復号）＋単体テスト（依存: T2）
- [x] T4: `screen/types.ts`（`Cell` / `CellKind` / `Field` / `ScreenSnapshot`）（依存: T1）
- [x] T5: `screen/attributes.ts`（基本属性バイト・拡張属性の解釈）＋単体テスト（依存: T2, T4）
- [x] T6: `screen/buffer.ts`（`Screen3270`。並列 typed array・EW/EWA のサイズ切替）＋単体テスト（依存: T4, T5）
- [x] T7: `protocol/inbound.ts`（コマンド・オーダーの適用。状態を持たない純関数）＋単体テスト（依存: T3, T6）
- [x] T8: `snapshot()`（フィールド導出・EBCDIC→文字）＋単体テスト（依存: T6）
- [x] T9: `@ts5250/ebcdic` を依存に追加（狭い入口 `…/codec` を使う）（依存: T8）
- [x] T10: 入口（`index.ts` / `browser.ts`）に公開面を追加（依存: T7, T8）
- [x] T11: `TN3270_E2E=1` で TK4- のウェルカム画面が `s3270` の `ReadBuffer(Ebcdic)` と一致することを確認（依存: T10）
  - **照合方法を変更**: 実ホストへ 2 本繋いで比べる方式は当てにならなかった（Hercules は装置ごとに
    状態を持ち、2 本目には空画面が返る）。**同じバイトを両方に流す**ため `mini3270` ハーネスを
    subtask 04 から前倒しで作り、TK4- 実採取の fixture を両者に食わせて照合した。
    結果: **属性桁 156 箇所と表示テキストが完全一致**
