# タスク: DBCS 欄のフォーカス時表示

- [x] **T1**: 落ちるテストを書く（列ビューの SO/SI 位置・センチネル非表示・桁数）
- [x] **T2**: `isWideForDbcs` / `viewChar` を作り、列ビュー系（columnView / dbcsViewLayout / columnViewLayout / dbcsByteLength）に適用
- [x] **T3**: フォーカス中の `el.value` 代入で `stripSentinels` を通す
- [x] **T4**: 通し確認（build / test / lint / vue-tsc）
