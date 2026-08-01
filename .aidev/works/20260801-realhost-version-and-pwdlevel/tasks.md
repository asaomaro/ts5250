# タスク: 実機の版数とパスワードレベルを実測で確定し、誤った前提を正す

- [x] T1: `scripts/README.md` に「検証に使う実機」節を新設する
      （実機 = 7.3 / PUB400 = 7.5、確かめ方 2 経路、**2026-08-01 以前の記録の 7.5 表記は誤り**
      という導線。spec D2）
- [x] T2: `.aidev/backlog/hostserver.md:67` のパスワードレベル項目を `[x]` にする
      （backlog 指定の手順を通した結果＋`password level : 0`。spec D3）
- [x] T3: `.aidev/backlog/hostserver.md:196` の版数の誤りを**取り消し線**で訂正し、
      「バージョン差の検証」の状態を実態（7.3 と 7.5 の両方で測っていた）に合わせる
- [x] T4: `.aidev/backlog/input-assist.md:30` と `window-detect.md:72,170` の
      `(IBM i 7.5)` を 7.3 に訂正する（依存: なし）
- [x] T5: `packages/web-ui/test/window-write-extent.test.ts:17` のコメントの版数を訂正する
- [x] T6: `test-result.md` に実測記録を残す（出力は伏字。spec D4）
- [x] T7: `npm run build` / `npm run lint` / `npm test` を通し、
      **`git diff` に資格情報が含まれていない**ことを走査で確かめる（依存: T1〜T6）
