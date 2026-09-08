# テスト結果: 転送が落ちてもセッションを失わない（猶予保持と再接続）

## 実行したもの

**ラウンド 2**（review ラウンド1 の差し戻しを反映したあと）。

- `npm run build`（`tsc -b`：ライブラリ 7 パッケージ ＋ server） — 成功
- `npm run build -w @ts5250/web-ui`（`vue-tsc -b && vite build`） — 成功
  （chunk サイズの警告のみ。既存の警告で本件とは無関係）
- `npm run lint`（`eslint .`） — **0 件**（exit 0）
- パッケージごとのテスト（`npx vitest run`。**合計 5539 passed / 0 failed / 41 skipped**）
  - `packages/base` — 52 / `packages/ebcdic` — 100 / `packages/scs` — 41
  - `packages/hostserver` — 991
  - `packages/tn3270` — 254（+38 skipped）/ `packages/tn5250` — 584 / `packages/vt` — 202
  - `packages/server` — **1337**（+3 skipped）
  - `packages/web-ui` — **1978**（4 シャードの合計: 469 + 535 + 542 + 432）
- `aidev smoke`（`node launcher/smoke.mjs`） — **pass**

> **ルートから `npx vitest run` を直接叩いた分は判定に使っていない。** AGENTS.md が
> 「web-ui のテストはパッケージ dir から実行する。ルートから実行すると Vite の vue plugin と
> フィクスチャの相対パスが解決されず、実際とは違う失敗が出る」と明記している流し方で、
> 実際に web-ui 側だけが大量に落ちた。パッケージ dir から流したものを正とする。

> **この環境ではメモリが足りず、既定の並列度で全件を一度に流せない**（7.7GB。
> `npm test` も `--maxWorkers=2` も途中で OS に落とされた）。そのため web-ui は
> `--shard=n/4` に割って単一ワーカーで流している。**割り方による取りこぼしは無い**
> ——4 シャードの合計（1978）が単一実行時の件数と一致する。

## 受け入れ基準ごとの判定

- **AC1**（転送断で猶予に入り、閉じられない）: **pass**
  — `packages/server/test/ws-reconnect-resume.test.ts`「転送断は猶予に入る」（`isHeld` まで確認）、
  `session-attach.test.ts`「最後の 1 つが転送断で落ちたら、猶予のあいだ残る」。
- **AC2**（猶予内に同じ `sessionId` で繋ぎ直すと同じセッションへ戻れる）: **pass**
  — サーバー側 `ws-reconnect-resume.test.ts`「猶予中のセッションへ resume で戻れて、猶予が解ける」、
  クライアント側 `session-reconnect.test.ts`「切れたら繋ぎ直しに入り、`resume: true` を送る」
  「成功したら口だけ差し替え、セッションはそのまま続く」。
- **AC3**（切断中にホストが送った最新画面が出る）: **pass**
  — `session-reconnect.test.ts`「繋ぎ直したら、留守中にホストが書いた画面が出る」。
  サーバー側は既存の `attach` が現在のスナップショットを返す挙動をそのまま使っている。
- **AC4**（切断で `busy`/`loading` が解け、状態が「切断」になり、切れたことが分かる）: **pass**
  — `disconnect-clears-busy.test.ts`。**伝え方は当初と変わった**——操作員メッセージではなく
  OIA の「再接続中 (1/5)」で示す（`decisions.md` D13 の周辺、T11 で整理）。
- **AC5**（再接続中と分かり、成功したら通常表示に戻る）: **pass**
  — `reconnect-oia.test.ts`（「再接続中 (n/5)」が「切断」より優先／`role="status"`）、
  `session-reconnect.test.ts`（成功で `reconnect` が消える）。
- **AC6**（猶予切れで確実に閉じ、枠と装置記述が解放される）: **pass**
  — `session-reconnect-grace.test.ts`「期限のタイマーが閉じる」（本筋）と
  「タイマーを取り逃しても掃除役が刈る」（保険）の 2 経路。
- **AC7**（`close` が来ない半開きでもクライアントが切断と判断する）: **pass**
  — `ws-ping-watchdog.test.ts`（`ping` 途絶で畳む／最初の `ping` 前は張らない／
  `close` イベントが来なくても保険で切断として扱う）。
- **AC8**（猶予は 5250 表示のブラウザ経路だけ。既存の判断を変えない）: **pass**
  — サーバー側「非常駐プリンターは転送断でも即閉じる」「他に見ている人が残っていれば猶予に
  入らない」「resume 無しの attach は従来どおり」、クライアント側「3270 は繋ぎ直さない」
  「既存セッションへ繋いだだけのタブは繋ぎ直しに行かない」。
  MCP / HLLAPI が開いたセッションは `ws-handler` を通らないので猶予に入らない（設計上の帰結）。
- **AC9**（既存が緑のまま、回帰テストが追加されている）: **pass**
  — 追加は **54 件**（サーバー 27 / クライアント 27）。既存はすべて緑。
  振る舞いを変えた 3 件（`session-attach` / `ws-handler` / `ws-lifetime`）は、
  緩めるのではなく**新旧の対比が残る形**に書き換えた（`decisions.md` D9）。
- **AC10**（繋ぎ直せなかった理由を示して切断状態にする）: **pass**
  — `session-reconnect.test.ts`「そのセッションはもう無い」（サーバーの理由をそのまま出す）／
  「試行が尽きたら手動の繋ぎ直しを出す」（`MSG_RECONNECT_GAVE_UP`）。
- **AC11**（他人のセッションは再アタッチできない）: **pass**
  — `ws-reconnect-resume.test.ts`「他人のセッションは resume できない」（`code: "FORBIDDEN"` まで確認）。
- **AC-I1**（覆わない・復帰で自動的に消える）: **pass**
  — 覆い（`busy-overlay`）は `busy` のときだけという既存の条件を変えていない。
  再接続の表示は OIA に出し、成功で `reconnect` を消すと自動的に消える（`reconnect-oia.test.ts`）。
- **AC-I2**（尽きたら手動の口を出す・押せば再開する）: **pass**
  — `reconnect-oia.test.ts`（`"retry"` のときだけボタン／`"gone"` では出さない／押すと emit）、
  `session-reconnect.test.ts`「手動の繋ぎ直しは、はしごを最初から回し直す」。
- **AC-I3**（キーボードだけで押せる）: **pass（一部は読みで確認）**
  — 素の `<button class="fk retry">` で、フォーカス移動＋Enter で押せる。クリックの emit は
  テストで固定。**Enter がペインまでバブルして AID になる問題**は点検で見つかり
  `@keydown.enter.stop` で塞いだが、**そのキー経路自体はテストで固定できていない**
  （下の「未検証の穴」）。
- **AC-I4**（フォーカスを奪わない）: **pass（読みで確認）**
  — 再接続の表示は `role="status"` の受動的な通知だけで、`StatusBar` は `focus()` を呼ばない。
  復帰後のフォーカスは既存のペインの仕組み（`focusCursorField`）に任せている。
  **「奪わないこと」を固定する回帰テストは無い**（下の「未検証の穴」）。
- **AC-I5**（切断中も操作ログ等は使える）: **pass（読みで確認）**
  — 覆いが出るのは `busy` のときだけで、切断・再接続中は `busy` が解けている。
  操作ログのトグルは `StatusBar` にあり、接続状態に依存しない。

## 失敗の証跡

**ラウンド 2 では失敗が発生していない。**

**ラウンド 1 では lint が落ちていた**（`test-result.md` に「指摘なし」と書いたのは、
smoke スクリプトを足す前の実行結果を見た誤り。review 工程で拾って差し戻した）:

```
$ npx eslint .

/workspaces/ts5250/launcher/smoke.mjs
   30:3  error  Unexpected console statement  no-console
   94:3  error  Unexpected console statement  no-console
   95:3  error  Unexpected console statement  no-console
  101:3  error  Unexpected console statement  no-console

✖ 4 problems (4 errors, 0 warnings)
```

coding 工程の途中では、振る舞いの変更に伴って既存 3 件が落ちた。いずれも
**「転送断で即座に閉じる」を固定していたテスト**で、変更の意図どおりに書き換えた
（経緯は `decisions.md` D9、指摘と対応は `review.md` のタスク点検ログ）。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":40,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"host":"127.0.0.1","port":39751,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 39751)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

**この work で `smokeCommand` を新設した**（それまで未設定で、`doctor` が
「テストが緑でも成果物が起動するかは誰も見ていません」と警告していた）。
`launcher/smoke.mjs` はサーバーを起こして `/healthz` と `/`（ビルド済み Web UI）を確かめ、
SIGTERM で素直に終わるところまで見て必ず終了する。

**新しい入口（サブコマンド・オプション）は足していない**ので、`smokeCommands` への
追加行は無い。`WsOpen.resume` は WS 電文のフィールドで、CLI の表面ではない。

## 未検証の穴（skip / 環境不足）

- **実機の瞬断からの復帰は未検証。** 単体テストで確かめたのは「猶予に入る／期限で閉じる／
  `resume` で戻る」までで、**実際に回線が落ちて戻る**ところは実機（`.env.verify` の環境）
  でしか確かめられない。design が着手時点で「未検証の穴として残す」と決めている。
  → PR 本文の「既知の制約」へ引き継ぐ。
- **キーボード経路の一部が未固定**（AC-I3 / AC-I4）。手動ボタンの Enter が AID にバブルしない
  こと、再接続の表示がフォーカスを奪わないことは**読みで確認しただけ**で、回帰テストが無い。
  `EmulatorPane` を丸ごとマウントして keydown を流す形なら書けるが、この work では書いていない。
- **既存の skip 41 件**（tn3270 の 38 件は docker の TK4- 環境が要る、server の 3 件）は
  本件と無関係の既存分。green だが**全数検証ではない**。
- **並行実行時のフレーク 1 件**: `packages/web-ui/test/tab-visibility.test.ts` の
  「全タブを畳んでもワークスペースに居られ、バッジは全数を出す」が、全ファイル並行実行時に
  5 秒のタイムアウトで落ちることがある。**本件の変更とは無関係**で、切り分けの根拠は 3 つ:
  - 単体実行では通る（8/8）。
  - **ワーカー数を絞れば全件通る**（`--maxWorkers=2` / `--shard` 分割の単一ワーカーとも緑）。
  - この環境はメモリ 7.7GB で、既定の並列度だと逼迫する（同じスイートを 3 連続で流したら
    **OS がメモリ不足でプロセスを落とした**）。落ちるのは 5 秒のタイムアウトで、
    アサーションの失敗ではない。
  つまり原因は**実行環境の負荷**であって実装ではない。CI の並列度かこのテストのタイムアウトを
  見直す価値はあるので、retro の候補として残す。
