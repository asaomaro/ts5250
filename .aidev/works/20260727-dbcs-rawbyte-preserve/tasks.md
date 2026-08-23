# タスク: DBCS 欄を編集しても SO/SI・全角のバイトを壊さない

- [x] **T1**: 落ちるテストを書く（SO/SI・全角の 1 文字編集で SUB が出ないこと）
- [x] **T2**: `!dbcs` ゲートを外し、未使用になった `dbcs` 変数を削除
- [x] **T3**: 実機で round-trip を確認
- [x] **T4**: 通し確認（build / test / lint / vue-tsc）
