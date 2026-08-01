# 仕様: 待ち受けの開始/停止と `stopped`

## 対象範囲

| ファイル | 変更 |
|---|---|
| `watch-registry.ts` | `WatchState = ServiceState` へ（`watching` → `listening`）／`stop()` が削除をやめる／`resume()` 新設／上限を待ち受け中で数える |
| `session-manager.ts` | `PrinterEntry.session` を省略可能に・`state`/`error`/`openOpts`/`onState` 追加／`startPrinter` `stopPrinter` 新設／`autoStart` を尊重／上限を待ち受け中で数える |
| `ws-messages.ts` | `printer-opened` に `state`（`startupCode` は省略可能へ）／`printer-state` 追加／`printer-start` `printer-stop` `watch-resume` 追加 |
| `ws-handler.ts` | 開始/停止のハンドラ・状態 push の配線 |
| `mcp-tools.ts` | `startupCode` が無い場合に状態を返す |
| `web-ui/WatchPane.vue` | `listening` / `stopped` の表示 |
| テスト 4 本 | 新規＋実態への更新 |
| `scripts/verify-printer-startstop.mjs` | 新規（実機の往復） |

## 設計判断

### D1. `startupCode` は省略可能にする（利用者の選択 A）

`autoStart ☐` で開くと接続していないので、起動応答コードは**存在しない**。
`printer-opened` に `state` を載せ、`startupCode` は待ち受け開始後に
`printer-state` で届ける。**「開く（登録する）」と「待ち受ける」が別**という
設計と一貫する。

### D2. 上限は `holdsConnection(state)` で数える

停止中・障害は接続を持たないので枠を占めない。
**これを間違えると自分で自分を締め出す**——`openPrinter` が登録してから
`startPrinter` を呼ぶので、登録済みのエントリを数えると
「開いた直後に上限」で必ず失敗する（実装中に踏んだ）。

### D3. 停止は状態を先に立てる

`session.disconnect()` は `closed` ハンドラを呼ぶ。先に `stopped` にしておかないと、
ハンドラが**明示停止を「障害」として記録する**（`WatchRegistry` の `stopping` フラグと同じ理屈）。

### D4. 停止と破棄は別

`stopPrinter` は残す、`close` は消す。停止で消すと一覧から落ちて再開できない。

## 未確定事項の解消

**停止中の `waitSpool`**: 停止時に待機者を `undefined` で起こす（`stopPrinter` が
`waiters.splice(0)` する）。**待たせ続けない**——待ち受けていないのだから、
永遠に来ないものを待たせるのは嘘になる。
