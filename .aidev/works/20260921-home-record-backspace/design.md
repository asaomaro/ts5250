# 仕様: Home・Record Backspace・欄データを載せない AID

## 設計方針
- コア: `AidKey` に `"RecordBackspace"`（0xF8）。`read-response.ts` に `NO_DATA_AIDS`（Clear・Help・Print・Record Backspace）を置き、`sendsData` の先頭で見る
  （READ MDT も READ INPUT FIELDS の平坦な応答も同じ門番を通る）。スナップショットに `home`（`icAddr ?? homeAddr()`）。
- サーバー: マクロのスキーマ（`aidKeySchema`。コアとの双方向の一致をコンパイル時に検査）と MCP の一覧に足す。キー設定の一覧にも足す。
- web-ui: ScreenGrid の欄内 Home を撤去してペインへ委譲。ペインの `homeKey()`: `snapshot.home`（無ければ先頭の入力欄）とカーソルが同じなら
  `onAid("RecordBackspace")`、違えば `noteFieldExited()` の後にそこへ移す。`sendKey` の検査から Record Backspace を外す。

## 依拠する既存の事実
- `buf.icAddr` は書式を消すまで持ち越す（`20260921-cursor-per-wtd-acs`）。`homeAddr()` は先頭の非バイパス欄、無ければ 0（`buffer.ts`）。
- `onAid` はエラー状態を抜けてから `sendKey` を呼ぶ（`EmulatorPane.vue`）。

## 受け入れ基準との対応
- AC1・AC2: `home-key-acs.test.ts`。AC3: `no-data-aid-home.test.ts`。AC4: mutation。
