# tasks: 第 1 段

- [x] `packages/terminal` の新設（package.json・tsconfig・root の references・eslint の transport 例外）
- [x] `render/frame.ts`（ScreenSnapshot → ANSI。CHA 固定・差分・状態行・切り詰め）
- [x] `input/decode.ts`（CSI/SS3/ペースト・ESC の flush）
- [x] `app/controller.ts`（移動・AID・SBCS 上書き・接頭キー）
- [x] `transport/cli.ts`（`ts5250-term`。`--replay` を含む）
- [x] 試験 56 本（frame / decode / controller）、`dependency-direction` に terminal を宣言
- [ ] 実機（利用者の設定の範囲で）での確認
- [ ] 第 2 段: 編集ロジックの Vue からの切り出し（別 work）
