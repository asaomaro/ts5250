# タスク: 03-input-outbound

- [x] T1: **AID コードと Read Modified の形式を実測で確定する**（mini3270 を受信側にして s3270 に押させる）
- [x] T2: `session/aid-keys.ts`（AID コード ⇔ キー名。T1 の実測を根拠に）（依存: T1）
- [x] T3: `protocol/outbound.ts`（Read Modified / Read Buffer 応答の生成）＋単体テスト（依存: T2）
- [x] T4: `screen/buffer.ts` に入力補助（次の非保護桁・欄の中身の書き換え）を追加（依存: なし）
- [x] T5: `session/emitter.ts`（最小のイベント発火）（依存: なし）
- [x] T6: `session/session.ts`（接続・状態機械・`type()` / `setCursor()` / `send()`）＋単体テスト（依存: T3, T4, T5）
- [x] T7: 入口（`index.ts` / `browser.ts`）に公開面を追加（依存: T6）
- [x] T8: 照合: 同じ入力に対する送信バイトが `s3270` と一致することを確認（依存: T3）
- [x] T9: 照合: 実ホストと往復する（依存: T6）
  - **範囲を変更**: TK4- には**入力を受け付ける画面が無い**（TSO も Hercules コンソールも
    キーボードがロックされたままで `String()` が `Operator error` になる）。
    そのため「接続 → 画面受信 → Enter 送信 → ホスト応答でロック解除」までを実ホストで確認し、
    **入力を伴う送信バイトの照合は自前のホスト役サーバで s3270 と突き合わせた**
