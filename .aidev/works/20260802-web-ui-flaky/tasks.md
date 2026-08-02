# タスク: web-ui のテストの不安定さを減らす

- [x] T1: 修正前の基準線を取る（7 回）
- [x] T2: 落ちた assertion を読む（focus 依存だと確かめる）
- [x] T3: `mount` / `unmount` の数を数える（893 / 469）
- [x] T4: `test/setup.ts`（自動 unmount ＋ フォーカス・DOM の掃除）
- [x] T5: `setupFiles` を配線
- [x] T6: 修正後を測る（6 回）
- [x] T7: 逐次・`maxWorkers=4` で並列度の影響を切り分ける
- [x] T8: `npm run build` / `lint`
