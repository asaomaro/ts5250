# タスク: サーバー設定を画面から作り始められるようにする

- [x] T1: `ServerConfigStore.fromFileOrEmpty`
- [x] T2: `main.ts` で既定パス `profiles.json` を使う（明示指定は従来どおり投げる）（依存: T1）
- [x] T3: 3 経路を実物で確認（既定・打ち間違い・既存ファイル）（依存: T2）
- [x] T4: `start.sh` が無ければ空で作る（依存: T2）
- [x] T5: `.gitignore` に `profiles.json`
- [x] T6: README（手で用意しなくてよい・明示指定の注意）
- [x] T7: 単体テスト（依存: T1）
- [x] T8: `npm run build` / `lint` / `npm test`
