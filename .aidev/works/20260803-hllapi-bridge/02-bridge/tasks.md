# タスク: 02-bridge

- [x] T1: `crates/hllapi` の骨格（`cdylib`・`std` のみ・OS 非依存）
- [x] T2: JSON の読み書き（交換する 4 項目だけ。**エスケープを正しく**）（依存: T1）
- [x] T3: HTTP/1.1 のクライアント（`TcpStream` 直書き・接続先は環境変数）（依存: T2）
- [x] T4: C ABI の入口（`hllapi` / `HLLAPI` / `WinHLLAPI`）。**ヌルポインタで落ちない**（依存: T3）
- [x] T5: Rust の単体テスト（JSON・要求組み立て・応答解析）（依存: T2, T3）
- [x] T6: C ABI の検証（Python `ctypes`）＋サーバーを起動しての往復（依存: T4）
- [x] T7: `docs/HLLAPI.md`（対応表・制約・ビルド手順・**未検証の明示**）＋ README（依存: T4）
- [x] T8: `cargo test` / `npm run build` / `npm run lint` / `npm test` を通す（依存: T5, T6, T7）
