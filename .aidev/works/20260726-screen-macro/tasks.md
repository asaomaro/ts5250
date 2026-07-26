# タスク: 5250端末画面のマクロ機能（記録・再生）

参照: `spec.md` の D1〜D11 / `plan.md` の Phase 1〜6。

## Phase 1: サーバー基盤（型・ストア・暗号化）

- [x] T1: `packages/server/src/macro-types.ts` を追加する。`ScreenMatch` / `MacroStepRecord` /
      `MacroRecord` / `PublicMacro` / `PublicMacroStep` / `MacroSecretRef` / `CreateMacroBody` を
      zod スキーマ＋型で定義する（`config-types.ts` に倣い `.strict()`）。（spec「インターフェース / データ構造」）
- [x] T2: `packages/server/src/macro-store.ts` を追加する（依存: T1）。`macros.json` の読み書き
      （原子的保存 tmp→rename）、`owner` と `assertOwner`、CRUD（list/get/create/rename/remove）、
      `toPublic()`（**`secretEnc` を落とす**）、`SecretCrypto` による暗号化、`resolveSecret()`。
      鍵未設定での秘密保存は `CONFIG_ERROR` で拒否する。（spec D5・D7）
- [x] T3: `packages/server/test/macro-store.test.ts` を追加する（依存: T2）。
      CRUD / owner 検証 / 暗号化保存 / **`toPublic()` に `secretEnc` も平文も含まれない** /
      鍵未設定での保存拒否 / 破損 JSON で既存を壊さない。（plan R-a・R-f・R-g）

## Phase 2: サーバー API・ws（REST・秘密の差し込み）

- [x] T4: `packages/server/src/macro-routes.ts` を追加し、`app.ts` に登録する（依存: T2）。
      `GET/POST/PUT/DELETE /api/macros`。`POST` の `plainSecrets` は暗号化して捨てる。
      `main.ts` で `MacroStore` を生成し `SecretCrypto` を渡す。（spec「REST」）
- [x] T5: `packages/server/test/macro-routes.test.ts` を追加する（依存: T4）。
      CRUD / 認証オン・オフ / 他人のマクロへのアクセス拒否 / 応答に秘密が出ない。
- [x] T6: `packages/server/src/ws-messages.ts` の `WsKey.fields` を
      「`{field, value}` か `{field, secretRef}`」のタグ付き union に拡張する（依存: T1）。
      **既存形はそのまま残す加算的変更**にする。（spec D11・plan R-b）
- [x] T7: `packages/server/src/ws-handler.ts` に `secretRef` の解決を実装する（依存: T4, T6）。
      `assertOwner` で所有者検証 → `decrypt` → `value` に差し替え → ホストへ書く。
      解決できなければ**キー送信自体を拒否**（空文字で送らない）。監査には macroId/step/field のみ残し
      値は残さない。既存の `assertKeyAllowed` / `assertWritable` の下に置く。（spec D11）
- [x] T8: ws の `secretRef` テストを追加する（依存: T7）。正常系 / 所有者違い / 復号失敗 /
      鍵未設定 → **いずれも値を送らずに拒否**されること。（plan R-a・R-g）

## Phase 3: web-ui 記録

- [x] T9: `packages/web-ui/src/stores/sessions.ts` の `SessionState` に `macro?: MacroRuntime` を足す
      （依存: T1）。`MacroMode` / `MacroRuntime` / `DraftStep` を定義する。（spec「マクロエンジンの実行時状態」）
- [x] T10: `packages/web-ui/src/stores/macros.ts` を追加する（依存: T4）。`/api/macros` の
      取得・作成・改名・削除。**秘密は保持しない**（`PublicMacro` のみ扱う）。
- [x] T11: `packages/web-ui/src/macro-engine.ts` の**記録側**を実装する（依存: T9, T10）。
      `startRecording` / `pauseRecording` / `resumeRecording` / `stopRecording`。
      `recordSend()` で `{fields, key, cursor, sysReqText}` を積み、`snapshot.fields[i].hidden` の欄は
      **平文をメモリの draft に隔離**して `ScreenMatch` を組む。`recordPaused` 中は積まない。
      GUI 選択が起きたら `incomplete` を立てる。（spec D1・D5・D8）
- [x] T12: `packages/web-ui/src/session-controller.ts` の `sendKey` に記録フックを差す（依存: T11）。
      **`idle` 時は完全素通し**（早期 return）。冒頭に俯瞰コメントを置く。（spec D2・plan R-c）
- [x] T13: 記録のテストを追加する（依存: T12）。状態遷移 / hidden 欄の平文が draft の外に出ない /
      `recordPaused` 中は記録しない / **`idle` 時に既存の `sendKey` 挙動が変わらない**。（受け入れ基準 A1・A8）

## Phase 4: web-ui 再生

- [x] T14: `macro-engine.ts` の**再生側**を実装する（依存: T11）。`play` / `pausePlay` /
      `resumePlay` / `stopPlay`。1 ステップごとに `ScreenMatch` を照合（**秘密ステップでは必須**）→
      `s.edits` に流し込む → `sendKey` → **`busy` が false になるまで待つ** → 次へ。
      秘密欄は値ではなく `secretRef` を送る。`promptFields` で自動休止。
      停止理由（`completed` / `user` / `mismatch` / `timeout` / `disconnected` / `readonly` / `secret`）を持つ。
      （spec D3・D4・D5・D9・D11）
- [x] T15: 再生のテストを追加する（依存: T14）。`busy` 待ちで取りこぼさない / `ScreenMatch` 一致・不一致 /
      `promptFields` での自動休止と再開 / タイムアウト・切断・readOnly での停止 /
      秘密欄が `secretRef` で送られ**平文がクライアントから出ない**。（受け入れ基準 A2・A3・A4）

## Phase 5: UI

- [x] T16: `packages/web-ui/src/components/StatusBar.vue` に OIA 表示を足す（依存: T14）。
      `⏺ 記録中` / `▶ 再生中` / `⏸ 休止中` を既存の `🔒 応答待ち` と同じ枠・意匠で。`role="status"`。
      停止理由も出す。（spec D10・受け入れ基準 A5）
- [x] T17: `packages/web-ui/src/components/MacroMenu.vue` を追加し `App.vue` のトップバーに置く
      （依存: T16）。一覧（秘密ありは鍵アイコン）・記録／再生／休止／停止・改名・削除・
      記録停止時の秘密 3 択ダイアログ。`.theme-btn` 意匠、`headerMenu.ts` に参加、
      `activeIsEmulator` のときだけ表示、**トグルは固定幅でレイアウトシフトを起こさない**。
      （spec D10・受け入れ基準 A6・plan R-h）
- [x] T18: マクロのキー割り当てを足す（依存: T17）。`stores/keybindings.ts` の割当先に `macro:<id>`、
      `composables/useKeymap.ts` で分岐（**ホストへ送らない**）、`KeybindingsPanel.vue` で選べるように。
      （spec D10）
- [x] T19: UI のテストを追加する（依存: T18）。OIA の状態表示 / メニューの一覧・操作 /
      `macro:<id>` バインドがホストへ送られない / 秘密ありマクロの鍵アイコン。（受け入れ基準 A5・A6）

## Phase 6: 仕上げ

- [x] T20: 全体を通す（依存: T19）。`cd packages/web-ui && npx vitest run` と server の全テスト、
      `npm run build -w @as400web/web-ui`（`vue-tsc -b && vite build`）、lint。
      既存テストの回帰が無いことを確認する。（受け入れ基準 A8・A9）
