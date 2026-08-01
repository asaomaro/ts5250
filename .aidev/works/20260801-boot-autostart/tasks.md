# タスク: 起動時の自動開始

- [x] T1: `boot-autostart.ts` に `startAutoServices()` を新設（対象の絞り込み・失敗の扱い）
- [x] T2: `main` で `WatchRegistry` を作って `buildApp` に渡す（依存: T1）
- [x] T3: `serve` のコールバックから呼ぶ（**HTTP の口を開けるのを待たせない**）（依存: T2）
- [x] T4: テスト 9 件（依存: T1）
- [x] T5: `npm run build` / `npm run lint` / `npm test`
