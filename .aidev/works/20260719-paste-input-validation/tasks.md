# タスク: 入力・ペースト時の検証と ACS 準拠メッセージ

- [x] T1: `fieldValidate.ts` に `rejectReason` を追加し `acceptsChar` を委譲に変える
- [x] T2: ScreenGrid にメッセージ定数と `RejectReason` → 文言の写像を置く（依存: T1）
- [x] T3: 打鍵・Backspace・Delete のメッセージ通知（依存: T2）
- [x] T4: `overwriteInto` で弾いた桁を消費する（既存 DBCS 不変）
- [x] T5: 挿入ペーストの一括拒否（依存: T2）
- [x] T6: `StatusBar` で notice があれば systemMessage を出さない
- [x] T7: `pasteMultiline` に横走査を足し、単一行も同経路に通す（依存: T4, T5）
- [x] T8: 既存テストの新仕様への書き換えと、修正前に落ちることの確認（依存: T4, T7）
