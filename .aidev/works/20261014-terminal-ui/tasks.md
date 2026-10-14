# tasks: 第 1〜3 段

- [x] `packages/terminal` の新設（package.json・tsconfig・root の references・eslint の transport 例外）
- [x] `render/frame.ts`（ScreenSnapshot → ANSI。CHA 固定・差分・状態行・切り詰め）
- [x] `input/decode.ts`（CSI/SS3/ペースト・ESC の flush）
- [x] `app/controller.ts`（移動・AID・SBCS 上書き・接頭キー）
- [x] `transport/cli.ts`（`ts5250-term`。`--replay` を含む）
- [x] 試験 56 本（frame / decode / controller）、`dependency-direction` に terminal を宣言
- [ ] 実機（利用者の設定の範囲で）での確認
- [x] 第 2 段: 編集ロジックの Vue からの切り出し（ブランチ `refactor/edit-logic-to-tn5250`。web-ui 3,121 本・tn5250 1,289 本が緑）

## 第 3 段
- [x] `app/editing.ts`（`edit/*` を呼ぶ糊。文字欄・O 欄）
- [x] controller: 挿入モード・Delete・Backspace・Field Exit・型の検査・満杯の自動送り・「出た」状態
- [x] 状態行に挿入を表示、CLI で `sbcsOnly` を渡す
- [x] 試験（挿入・Delete・Field Exit・行またぎ・O 欄の SO/SI・型の拒否）
- [ ] 実機（PUB400）で挿入・Delete の確認
- [ ] 継続欄・語送り・J・E・G・Field±
- [ ] `opMessages` の置き場（文言の二重化）

## 第 4 段（ts5250 / ts5250ctl）
- [x] `@ts5250/cli`（args・server-process・ts5250・ts5250ctl）、試験 9 本
- [x] terminal: `run.ts`（入出力ループの切り出し）・`ws-session.ts`・`overlay.ts`、`--ws` フラグ、試験 3 本
- [x] 実機（PUB400）: `ts5250` でサーバー起動→サインオン済みメニュー→挿入・Enter→終了でサーバー停止。`ts5250ctl list/describe/ツール実行`
- [ ] `ts5250 serve` の Windows での確認（パス区切り・`--env-file`）
- [ ] 認証オン（`--users`）のサーバーへの `ts5250`／`ts5250ctl`（Cookie・トークン）
