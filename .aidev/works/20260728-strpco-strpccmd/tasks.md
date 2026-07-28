# タスク

- [x] T1 core: PCO 標識の検出（`protocol/pc-command.ts` ＋ `wtd-applier.ts` から呼ぶ）と `ApplyResult` 拡張
- [x] T2 core: `ConnectOptions.onPcCommand` と `Session5250.handleRecord` の分岐（中間画面を出さない・必ず実行キー）
- [x] T3 core: ユニットテスト（実測レコードの hex を fixture に、PAUSE 双方・終了標識・誤検出しないこと）
- [x] T4 server: `pc-command.ts`（spawn・timeout・allow・結果型）とユニットテスト
- [x] T5 server: `config-types.ts` に `pcCommandSchema`（サーバー設定のみ）／`config-routes.ts` の 3・4 層／`config-resolver.ts` の 5 層
- [x] T6 server: `session-manager.ts` の配線（`OpenOptions.pcCommand`・履歴・push フック）と `ws-handler.ts` / `ws-messages.ts`
- [x] T7 server: 信頼境界のテスト（個人設定は 400／printer 種別で落ちる／一般ユーザーは 403／解決器は server 由来のみ）
- [x] T8 web-ui: `opMessages.ts` の定数・`stores/sessions.ts` の状態・`session-controller.ts` の受信・`SessionInfo.vue` の表示
- [x] T9 web-ui: `ConfigCard.vue` の設定 UI（display かつサーバー設定編集可のときだけ）
- [x] T10 web-ui: コンポーネントテスト（通知文言は定数参照・実行先の言い換え）
- [x] T11 実機 E2E: `scripts/verify-pcocmd.mjs`（PAUSE(*NO)/(*YES)・無効時・許可リスト外）
- [x] T12 ドキュメント: README / `docs/` / `scripts/README.md` / `profiles.json.example`
