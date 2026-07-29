# テスト結果: セッションの寿命（アイドルタイムアウト・永続）

## 自動テスト

| 対象 | 結果 |
|---|---|
| core / server / ebcdic / scs | **1741 passed** / 145 ファイル（4 failed は既知の環境不足。下記） |
| web-ui（パッケージ dir から実行） | **1176 passed** / 102 ファイル。**unhandled error 0** |
| `tsc -b` | 通る |
| `vue-tsc -b` ＋ `vite build` | 通る |
| lint（変更した追跡ファイル） | error 0 |

### 新規テスト

| ファイル | 件数 | 見ているもの |
|---|---|---|
| `packages/server/test/session-idle-timeout.test.ts` | 22 | 既定＝永続 / エントリ毎判定 / 表示・プリンター両方 / `touch()` / `orphanSafeIdleTimeoutMs()` / スキーマ（0・null・1441・小数を拒否）/ `idleTimeoutToMs()` / API 応答への露出 / `--idle-timeout` の解釈 |
| `packages/server/test/ws-lifetime.test.ts` | 14 | 設定の転記（**プリンター経路を含む**）/ `activity` → `touch` / `open` 前の無視 / 心拍の送信・死判定・pong 以外での延命・停止・プリンター |
| `packages/server/test/mcp-session-lifetime.test.ts` | 5 | MCP は `"never"` を 30 分に落とす（display / printer）。有限値は尊重 |
| `packages/server/test/config-resolver.test.ts`（追記） | +3 | 分 → ms は解決の 1 か所で行う |
| `packages/web-ui/test/session-activity.test.ts` | 6 | `noteActivity` の間引き・payload なし・セッション跨ぎで持ち越さない |
| `packages/web-ui/test/ws-heartbeat.test.ts` | 5 | `ping` → `pong` 自動応答 / 上の層へ渡さない / 心拍・合図を操作ログに出さない |
| `packages/web-ui/test/pane-activity.test.ts` | 6 | 打鍵・クリックで出る / **開いただけ・ホスト発の更新では出ない** / 間引き / 値を載せない |
| `packages/web-ui/test/config-card-idle-timeout.test.ts` | 7 | 概要行（未設定は出さない）/ フォームの往復（既定・never・分） |

### 既存テストの修正（実装の欠陥ではない）

- `ffw-behavior-bits.test.ts` / `view-cycle-ui.test.ts`: `sent` に `activity` が混ざるようになったので、
  集める側で除外した。これらが見たいのは「**ホストへ**送ってしまっていないか」で、
  WS の内部往復（アイドル判定用）は対象ではない
- `pane-cursor-window` / `pane-nav` / `pane-nav-from-protected` / `pane-protected-input` /
  `pane-word-jump-input`: `client: {} as WsClient` と偽っていた seed 7 箇所に `send` を足した。
  **そのままだと Vue のエラーハンドラが `s.client.send is not a function` を飲み込み、
  テストは緑のまま unhandled error が 34 件出る**（false green）状態になっていた

## 空振り検証（mutation）: 28/28

実装を 1 か所ずつ壊し、対応するテストが落ちるかを確認した（`0 件`＝全て検出）。

エントリ毎判定 / 永続の除外 / 既定値 / entry への転記（表示・プリンター）/ `touch` の 2 経路 /
`orphanSafe` / MCP の 2 か所 / resolver / 分→ms / `ws-handler` のプリンター転記 /
心拍の死判定・送信・延命・停止 / `activity`→`touch` / 打鍵・クリックの合図 /
**合成イベントから出す（＝ホスト更新を在席と数える）** / 間引き / 送信 / `pong` / 静かなログ /
概要行の条件 / フォームへの読み込み / API 露出。

初回は 3 件が空振りし、いずれも**テストではなく検証の作りの問題**だった:

1. 「`never` を除外しない」→ `now - "never"` が NaN になり比較が常に false ＝ 挙動が変わらない
   ミュータント。`never` を `0` として扱う形に変えて検出した
2. 「`delete form.idleTimeout` を外す」→ `JSON.stringify` が `undefined` のキーを落とすため
   **元の `delete` が死んだコード**だった。削除し、コメントで理由を残した
3. 「API 応答に出さない」→ web-ui のテストは `fetch` をスタブするのでサーバー側の
   `publicSession()` を通らない。**サーバー側のテストを足して**検出した

## 手で確かめたこと

- `--idle-timeout never` で起動する（`127.0.0.1:3493` で待ち受けを確認）
- `--idle-timeout 0` は起動時にエラー終了し、理由が日本語で出る

## 実機検証（2026-07-29 追記・実機）: 11/11

`scripts/verify-browser-idle.mjs`（実ブラウザ Playwright ＋ 実機・約 5 分）。
**掃除の間隔だけ `startIdleSweep(2000)` に縮めた**（判定そのものは実装のまま。超過を見つけてから
切るまでの待ち時間を削っているだけ）。

| 見たもの | 結果 |
|---|---|
| 設定フォームに「無操作で切る」がある／選択肢が「サーバー既定に従う」「切らない」＋分 | OK |
| 設定ファイルに直接書いた `1`（一覧に無い分数）が空欄にならず選択される | OK（**この検証で見つけた不備を直した**。下記） |
| **既定（永続）で 110 秒放置しても切れない** | OK（elapsed=110s） |
| **ハートビートの往復が成立している**（pong を返さなければ 90 秒で半開き判定＝上が成立しない） | OK |
| **`idleTimeout: 1` ＋ 打鍵継続（AID キーは押さない）で 95 秒切れない** | OK（在席の合図が効いている） |
| **`idleTimeout: 1` ＋ 放置で切れる** | OK（**60 秒で切断**） |
| 設定した 1 分より早くは切らない | OK（elapsed=60s） |

**同じ設定（`idleTimeout: 1`）で「打鍵していれば 95 秒生き残り」「放置すると 60 秒で切れる」**——
この対比が在席の合図が実際に効いている証拠になる（設定が届いていないなら後者も切れない）。

画面: `01-settings-form` / `02-connected-default` / `03-alive-after-110s-idle`（OIA が `入力可`）/
`04-alive-while-typing`（同）/ `05-closed-after-idle`（**OIA が `切断`**）。

### 実機検証で見つけた不備（修正済み）

`ConfigCard` の「無操作で切る」は選択肢を `[5,10,15,30,60,120,240]` の固定リストにしていたため、
**設定ファイルに直接書いた値（1〜1440 の任意）が一覧に無いと select が空欄で描かれ**、
「設定されていない」ように見えていた（値そのものは保持されるので、黙って消えるより分かりにくい）。
現在値が一覧に無ければ足すようにし、単体テスト 2 件を追加した。

## 未検証の穴（deliver へ引き継ぐ）

- **実時間の長い有限値（30 分・60 分）は試していない。** 実機では 1 分設定で確かめ、
  それ以外の値の判定は注入した `now()` で検証している（同じ `expired()` を通る）
- `packages/server/test/zip-writer.test.ts` の 4 件は**この環境に `unzip` が無い**ため失敗する
  （`main` でも同じ。今回の変更とは無関係）
