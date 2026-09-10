# テスト結果: 繋ぎ直し成功後のフレーム遮断を R4 の内側で塞ぐ

## 実行したもの

- `npm run test --workspaces --if-present`（全パッケージ）— **5675 passed / 1 failed / 41 skipped**
  - 内訳: 52 / 100 / 991 / 41 / 1416(+3 skip) / 254(+38 skip) / 584 / 202 / **2025(+1 failed)** / 10
  - **failed 1 件は本件と無関係の既存フレーク**（下記「失敗の証跡」で baseline と突き合わせ済み）
- `npx vue-tsc -b tsconfig.json tsconfig.test.json`（web-ui。`src` と `test` の両方）— エラー 0
- `npx vitest run`（web-ui 単独）— **2026 passed / 0 failed**（並列負荷が下がるとフレークは出ない）
- 変異による確認 3 件（下記「受け入れ基準ごとの判定」に個別に記載）

**本 work が足したテストは 12 件**（baseline 合計 5664 → 5676）。

## 受け入れ基準ごとの判定

- **AC1: pass** — 「繋ぎ直しに成功した口から届いた画面が反映される」（`test/session-reconnect.test.ts`）。
  `s.snapshot` / `s.cursor` が届いた画面と一致。**修正前は赤**（AC10 の実測ログ）。
- **AC2: pass** — 「…`key-done` で応答待ちが解ける」。`sendKey` で `s.busy` が立ち、`key-done` で false に戻る。
  **修正前は赤**。
- **AC3: pass** — 「…予約・PC コマンド・ジョブ・エラーも通る」と「…`closed` が届いたら、切断として記録される」の 2 件。
  `error` は `toBeDefined()` ではなく `wsErrorNotice()` の戻り値と突き合わせている（同じ `it` の
  `pc-command` が立てた通知で緑になるのを避けるため。タスク点検 T1 の指摘）。**修正前は 2 件とも赤**。
- **AC4: pass** — 既存の「打ち切った試行から遅れて届いた画面で、接続中に戻らない」が緑のまま。
  **このテストは 1 文字も書き換えていない**（`git diff` で確認）。
- **AC5: pass** — 「繋ぎ直しに成功したあと再び切れたら、繋ぎ直しのはしごが回る」。
  **変異で確認**: `sessionsStore.setClient(...)` を素の `cur.client = client` に戻すと当該テストが赤、戻すと緑。
- **AC6: pass** — `stores/sessions.ts` の `updateScreen` の注記を書き直した（**実装は 1 行も変えていない**）。
  「打ち切った試行は弾かれ続ける」「弾かれない組合せは第 2 項が真である間ずっと」「到達根拠は 2 系統」を
  書き分けた。数えは 2 度直している（`decisions.md` D5 → D10 → D11）。
- **AC7: pass** — 述語は `session-link.ts` に定義し、`session-controller.ts` は呼ぶだけ
  （`grep '=== client'` が 0 件）。`lifetime-flag-containment.test.ts` は 7 件緑。
  **変異で確認**: `onClose` を生比較に戻すと走査が赤／`s.client` への代入を store 外に足すと走査が赤。
- **AC8: pass（条件つき）** — 既存の回帰は緑。唯一の failed は baseline でも同じ形で落ちる既存フレークで、
  **本 work の変更が原因ではないことを実行で確かめた**（下記）。
- **AC9: pass** — `aidev smoke` が exit 0（下記「起動確認」）。
  **`smokeCommands` に行は足していない**——本 work は新しい入口（サブコマンド・オプション）を
  1 つも足しておらず、既存の判定を直しただけなので、起動確認の表面は変わらない。
- **AC10: pass** — 追加した 4 件が**修正前に落ちる**ことを実行で確認済み（下記のログ）。
  AC5 のテストも同様に変異で赤化を確認した。

## 失敗の証跡

### 1. 全パッケージ実行で 1 件失敗（既存フレーク）

```
 ❯ test/tab-visibility.test.ts (8 tests | 1 failed) 5584ms
     × 全タブを畳んでもワークスペースに居られ、バッジは全数を出す 5059ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/tab-visibility.test.ts > 畳んだタブグループのタブも「開いている」 > 全タブを畳んでもワークスペースに居られ、バッジは全数を出す
Error: Test timed out in 5000ms.
 ❯ test/tab-visibility.test.ts:125:3

 Test Files  1 failed | 161 passed (162)
      Tests  1 failed | 2025 passed (2026)
```

**本件と無関係であることの根拠**（推測ではなく実行）: 変更を `git stash push -u -- packages/` で
退避し、**同じコマンドを baseline（main の状態）で実行**したところ、**同じテストが同じ形で落ちた**。

```
$ git stash push -u -- packages/ && npm run test --workspaces --if-present
     × 全タブを畳んでもワークスペースに居られ、バッジは全数を出す 5125ms
 FAIL  test/tab-visibility.test.ts > 畳んだタブグループのタブも「開いている」 > 全タブを畳んでもワークスペースに居られ、バッジは全数を出す
 Test Files  1 failed | 160 passed (161)
      Tests  1 failed | 2013 passed (2014)
```

`.aidev/backlog/session-lifecycle.md` に**既に起票済み**の項目（「並列実行時に 5 秒タイムアウトで落ちる。
本件とは無関係の既存フレーク」）で、本 work の `requirements.md` は対象外と明記している。
web-ui 単独実行（並列負荷が低い）では 2026 件すべて緑。**差し戻しは行わない。**

### 2. 修正前に落ちることの確認（AC10）

`acceptsFrame` への差し替え前、T1 で追加した 4 件はすべて赤だった。

```
 FAIL  test/session-reconnect.test.ts > 転送断からの繋ぎ直し > 繋ぎ直しに成功した口から届いた画面が反映される
 FAIL  test/session-reconnect.test.ts > 転送断からの繋ぎ直し > 繋ぎ直しに成功した口から届いた `key-done` で応答待ちが解ける
 FAIL  test/session-reconnect.test.ts > 転送断からの繋ぎ直し > 繋ぎ直しに成功した口から届いた予約・PC コマンド・ジョブ・エラーも通る
 FAIL  test/session-reconnect.test.ts > 転送断からの繋ぎ直し > 繋ぎ直しに成功した口から `closed` が届いたら、切断として記録される
      Tests  4 failed | 27 passed (31)
```

### 3. 変異による確認（3 件）

```
$ # (a) 口の差し替えを store 経由から素の代入に戻す
      × 繋ぎ直しに成功したあと再び切れたら、繋ぎ直しのはしごが回る 18ms
      Tests  1 failed | 31 skipped (32)

$ # (b) acceptsFrame を第 2 項だけに縮める / 口の代入を store の外に足す
     × 代表の試行なら、セッションの口でなくても通す（第 1 項） 7ms
     × セッションの口への代入は stores/sessions.ts の中だけ 35ms
      Tests  2 failed | 10 passed (12)

$ # (c) onClose を生の口比較に戻す
      Tests  1 failed | 5 passed (6)
```

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":40,"time":1789029036420,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789029036436,"host":"127.0.0.1","port":44931,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 44931)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

**GO**。ビルドした成果物がサーバーを起こし、`/healthz` と Web UI の応答まで到達している。

## ラウンド 2（review ラウンド1 の差し戻し後）

**差し戻しの内容**: 共通ガードの第 2 項に `connected` の門を付けた（T10。`decisions.md` D12）。
はしごが回っている間ずっと第 2 項が真になり、CLOSING のソケットからのフレームで
「繋がっている」へ戻る経路が残っていたため。

- `npm run test --workspaces --if-present` — **5679 passed / 1 failed / 41 skipped**
  （failed 1 はラウンド 1 と同じ既存フレーク。下の証跡を参照）
- `npx vue-tsc -b tsconfig.json tsconfig.test.json` — エラー 0
- `npx vitest run`（web-ui 単独）— **2030 passed / 0 failed**
- **本 work が足したテストは 16 件**（baseline 合計 5664 → 5680）。ラウンド 1 の 12 件に、
  T10 で 4 件（真理値表 3 件＋経路 1 件）を追加。

**受け入れ基準の再判定**: AC1〜AC10 はいずれも pass のまま。門を足したことで
**AC4（打ち切った試行を弾く）はむしろ強くなった**——はしごの最中はセッションの口からのフレームも
通らなくなり、`decisions.md` D5 / D10 / D11 が「塞がない」と 3 度判断した穴が閉じた（D12）。

**変異による確認（ラウンド 2 で追加）**:

```
$ # 第 2 項から connected の門を外す / 代入の走査を `!` 付きの形で破る
     × **はしごの最中は、セッションの口でも第 2 項を通さない**（review ラウンド1 の must） 7ms
     × 諦めた後（`lost`）も第 2 項を通さない 1ms
     × セッションが消えていれば（`link` が無い）第 2 項を通さない 1ms
     × セッションの口への代入は stores/sessions.ts の中だけ 39ms
     × はしごの最中は、前回成功した口から届いた画面で「接続中」に戻らない 5ms
      Tests  5 failed | 43 passed (48)
```

**ラウンド 2 の失敗の証跡**: 新規の失敗は発生していない。唯一の failed はラウンド 1 と同一の
既存フレークで、baseline でも同じ形で落ちることを実行で確かめてある（上記「失敗の証跡」1.）。

```
 FAIL  test/tab-visibility.test.ts > 畳んだタブグループのタブも「開いている」 > 全タブを畳んでもワークスペースに居られ、バッジは全数を出す
      Tests  1 failed | 2029 passed (2030)
```

**起動確認（ラウンド 2）**:

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 46621)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## ラウンド 3（review ラウンド2 の差し戻し後）

**差し戻しの内容**: 初回接続の口にも同じ門を当て（T11。`decisions.md` D13）、
`openSession` の `onClose` も述語化した（同 D14）。

- `npm run test --workspaces --if-present` — **5685 passed / 0 failed / 41 skipped（exit 0）**
  **今回は既存フレークも通った**——タイミング依存であることの追加の傍証（ラウンド 1 / 2 では落ちていた）。
- `npx vue-tsc -b tsconfig.json tsconfig.test.json` — エラー 0
- **本 work が足したテストは 21 件**（baseline 合計 5664 → 5685）。

**受け入れ基準の再判定**: AC1〜AC10 はいずれも pass。**AC8 の条件が外れた**——
ラウンド 1 / 2 で唯一 failed だった既存フレークが今回は緑で、全パッケージが 0 failed。

**変異による確認（ラウンド 3 で追加）**:

```
$ # 初回接続の口の門（`default` 枝 / `error` 枝を個別に素通しにする）
     × 初回接続の口も、はしごの最中は画面で「接続中」に戻さない
     × 初回接続の口の `error` は、繋がっている間は通り、はしごの最中は通らない

$ # openSession の onClose の門
     × 同じ id で開き直したあと、古い口の切断でははしごを始めない 5ms
      Tests  1 failed | 36 passed (37)
```

**固定できなかったもの（正直に記録する）**: `tryResume` の `onClose` の門だけを外しても
37 件すべて緑のまま（実測）。その先の `resumeVerdict` が `running` を返して弾くため、
**この門は保険**であり、テストでは discriminate できない。作り話のテストは足さず、
コードとテストの注記に事実として残した（`isCurrentAttempt` の `!a.settled` と同じ扱い）。

**起動確認（ラウンド 3）**:

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45551)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）

- **実機での瞬断からの復帰は通していない**（`.env.verify`）。単体テストと型検査のみ。
  これは `.aidev/backlog/session-lifecycle.md` の別項目として既に起票済みで、本 work では解消していない。
  **利用者の目に映る症状（画面が固まる・覆いが消えない）を実機で確認していない**ことは deliver に引き継ぐ。
- **skipped 41 件**（環境依存。baseline と同数で、本 work が増やしていない）。
- ~~「閉じたソケットにはメッセージが配送されない」は単体テストでは検証できない~~
  **ラウンド 2 で解消**: この前提自体が誤りだった（CLOSING のソケットを覆っていない）。
  D12 で第 2 項に `connected` の門を付けて塞いだので、**ブラウザ仕様に依存する主張はもう
  結論に使っていない**。残る 1 つ（代表の試行から `opened` より前に `screen` / `key-done` が来る）は
  畳み込み前から同じで、本 work が空けた穴ではない。
- **実機のソケットの挙動そのものは確かめていない**——テストのフェイク `WsClient` は `close()` を
  記録するだけなので、「CLOSING でも配送される」というブラウザの実挙動は**読解で裏を取っただけ**
  （`ws-client.ts` の `closeFallback` と `message` の受け口に `readyState` の検査が無いこと）。
- **既存フレーク**（`tab-visibility.test.ts`）は本 work では直していない（backlog の別項目）。
