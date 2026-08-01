# 仕様: プリンターの常駐

`design.md` の D1〜D3 を実装に落とす。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/server/src/session-manager.ts` | `PrinterEntry.resident` / `isResident()` / `size` から常駐を除く / `maxResidentPrinters` / `sweepIdle` で常駐を飛ばす |
| `packages/server/src/ws-handler.ts` | `dispose()` で常駐は `close()` しない |
| `packages/server/src/host-printers.ts` | **新設**。`GET /api/printers` |
| `packages/server/src/app.ts` | ルート登録 |
| `packages/server/test/printer-residency.test.ts` | 新規 |
| `packages/server/test/host-printers.test.ts` | 新規 |
| `scripts/verify-printer-residency.mjs` | 新規（実機の通し確認） |

## 振る舞いの詳細

### 常駐の決まり方（D1）

`openPrinter` の入口で **`opts.output !== undefined` なら `resident: true`**。
呼び出し側は指定しない。出力設定はサーバー設定由来のときしか供給されないので、
**常駐の条件と信頼境界がちょうど重なる**。

### WS 切断（D1）

`dispose()` は購読（`onReport` / `onOutputWarn` / `onOutputStatus`）を外すだけで、
常駐は `close()` しない。**記録はエントリ側に溜まり続ける**ので、
開き直したときに閉じている間のぶんが読める。

### アイドル掃除（D1）

`sweepIdle` は `entry.resident` を見て飛ばす。

### 上限（D3）

- `size`（表示の上限判定）から**常駐を除く**
- 常駐には別の上限 `maxResidentPrinters`（既定 4）

### 一覧 API（D2）

`GET /api/printers`。**出力設定の中身（パス・プリンター名）は出さない**——
信頼設定なので `hasOutput: boolean` に畳む。警告は**新しい順**。
所有で絞る（`listPrinters(user)`）。

## エラー処理 / 異常系

- 常駐の上限に当たったら `SESSION_LIMIT`（メッセージで表示の上限と区別する）
- `isResident` は知らない id に `false`——**知らないものを常駐扱いしない**
  （切り忘れて溜まる方が、切りすぎるより後から気づきにくい）
