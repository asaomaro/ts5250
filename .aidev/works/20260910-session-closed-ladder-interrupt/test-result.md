# テスト結果: ホスト終了がはしごの最中に届くと取りこぼすのを直す

## 実行したもの

- `npm run test --workspaces --if-present`（全パッケージ）— **5695 passed / 1 failed / 41 skipped**
  - 内訳: 52 / 100 / 991 / 41 / 1416(+3 skip) / 254(+38 skip) / 584 / 202 / **2040(+1 failed)** / 10
  - **failed 1 件は本件と無関係の既存フレーク**（下記「失敗の証跡」で baseline と突き合わせ済み）
- `npx vue-tsc -b tsconfig.json tsconfig.test.json`（web-ui。`src` と `test` の両方）— エラー 0
- `npx vitest run`（web-ui 単独）— **2041 passed / 0 failed**
- 変異による確認 2 件（下記「受け入れ基準ごとの判定」に個別に記載）

**本 work が足したテストは 6 件**（前 work の着地時点 5685 → 5691。うち web-ui 単独ベースで
2035→2041 の +6）。

## 受け入れ基準ごとの判定

- **AC1: pass** — 「はしごの最中でも、前回成功した口から届いた `closed` でホスト終了と分かり、
  はしごが止まる」（D-a）と「初回接続の口でも…」（D-b）の 2 件。`link` が `{state:"lost",cause:"hostEnded"}`
  になることを確認。**修正前はどちらも赤**。
- **AC2: pass** — 同 2 件のうち `sendKey` → `MSG_SESSION_ENDED` の確認部分。
- **AC3: pass** — 同 2 件のうち、`runAttempt(60_000)` 後も `clients.length` が増えないことの確認。
- **AC4: pass** — `acceptsLifetimeSignal` は `session-link.ts` に定義され、
  `session-controller.ts` は 2 か所とも呼ぶだけ（生の判定を組み立てていない）。
  **変異で確認**: `acceptsLifetimeSignal` を第 2 項単体に縮めると `test/session-link.test.ts` の
  新規 1 件が赤化、戻すと緑（cross 点検の指摘を受けて追加）。
- **AC5: pass** — 既存の順序 A テスト 2 件（「ホスト側が終わっているセッションは繋ぎ直さない」・
  「`ended` の無い `closed`（サーバーの後始末）では繋ぎ直しを止めない」）が緑のまま。
  **このテストは 1 文字も書き換えていない**（`git diff` で確認）。
- **AC6: pass** — 「打ち切った試行から遅れて届いた `closed` でも、はしごを乱さない」。
  `closed` を `connected` の門から外しても、口の同一性が合わなければ通さないことを確認。
- **AC7: pass（条件つき）** — 既存の回帰は緑。唯一の failed は baseline でも同じ形で落ちる
  既存フレークで、本 work の変更が原因ではないことを実行で確かめた（下記）。
- **AC8: pass** — `aidev smoke` が exit 0（下記「起動確認」）。新しい入口は足していないので
  `smokeCommands` への追加は無し。
- **AC9: pass** — 追加した 2 件（D-a・D-b）が**修正前に落ちる**ことを実行で確認済み。

## 失敗の証跡

### 1. 全パッケージ実行で 1 件失敗（既存フレーク）

```
 ❯ test/tab-visibility.test.ts (8 tests | 1 failed) 5627ms
     × 全タブを畳んでもワークスペースに居られ、バッジは全数を出す 5053ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/tab-visibility.test.ts > 畳んだタブグループのタブも「開いている」 > 全タブを畳んでもワークスペースに居られ、バッジは全数を出す
Error: Test timed out in 5000ms.
 ❯ test/tab-visibility.test.ts:125:3

 Test Files  1 failed | 161 passed (162)
      Tests  1 failed | 2040 passed (2041)
```

**本件と無関係であることの根拠**（推測ではなく実行）: 変更を `git stash push -u -- packages/` で
退避し、**同じコマンドを baseline（main の状態）で実行**したところ、**同じテストが同じ形で落ちた**。

```
$ git stash push -u -- packages/ && npm run test --workspaces --if-present
     × 全タブを畳んでもワークスペースに居られ、バッジは全数を出す
 FAIL  test/tab-visibility.test.ts > 畳んだタブグループのタブも「開いている」 > 全タブを畳んでもワークスペースに居られ、バッジは全数を出す
 Test Files  1 failed | 161 passed (162)
      Tests  1 failed | 2034 passed (2035)
```

`.aidev/backlog/session-lifecycle.md` に既に起票済みの既存フレーク（並列実行時に 5 秒タイムアウトで
落ちる。本 work とは無関係）。**差し戻しは行わない。**

### 2. 修正前に落ちることの確認（AC9）

```
 FAIL  test/session-reconnect.test.ts > 転送断からの繋ぎ直し > はしごの最中でも、前回成功した口から届いた `closed` でホスト終了と分かり、はしごが止まる
AssertionError: expected { state: 'reconnecting', …(2) } to deeply equal { state: 'lost', cause: 'hostEnded' }
 FAIL  test/session-reconnect.test.ts > 転送断からの繋ぎ直し > 初回接続の口でも、はしごの最中に届いた `closed` でホスト終了と分かり、はしごが止まる
AssertionError: expected { state: 'reconnecting', …(2) } to deeply equal { state: 'lost', cause: 'hostEnded' }
      Tests  2 failed | 38 passed (40)
```

### 3. 変異による確認（2 件）

```
$ # (a) session-controller.ts の case "closed" から abortReconnect(sessionId) を外す
     × はしごの最中でも、前回成功した口から届いた `closed` でホスト終了と分かり、はしごが止まる
      Tests  1 failed | 39 skipped (40)

$ # (b) acceptsLifetimeSignal を isSessionClient(live, from) 単体に縮める（cross 点検の指摘）
     × acceptsLifetimeSignal: 代表の試行自身の口からの closed は第 1 項だけで通る
      Tests  1 failed | 11 passed (12)
```

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 46059)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

**GO**。

## ラウンド 2（review ラウンド1 の差し戻し後）

**差し戻しの内容**: コメントのみの修正（`case "closed"` の注記から `decisions.md` の
D番号無し参照を外し、design.md D-c 単独を指す形に。review ラウンド1 の should）。
**振る舞いの変更は無い。**

- `npm run test --workspaces --if-present` — **5695 passed / 1 failed / 41 skipped**
  （failed 1 はラウンド 1 と同じ既存フレーク）
- `npx vue-tsc -b` — エラー 0
- `aidev smoke` — pass

コメントのみの変更のため、新規の失敗・回帰は無い。

## ラウンド 3（review ラウンド2 の差し戻し後）

**差し戻しの内容**: T3・T4 のガード条件を `msg.type === "closed"` から
`msg.type === "closed" && msg.ended === true` に狭めた（T8。`decisions.md` D6）。
組み込みレビューが見つけた must——transport 起因の `closed` が確定済みの notice
（`MSG_RECONNECT_GAVE_UP` 等）を黙って消す退行があった。

- `npm run test --workspaces --if-present` — **5697 passed / 0 failed / 41 skipped（exit 0）**
  **既存フレークも今回は通った**（ラウンド 1・2 では落ちていた。タイミング依存の追加の傍証）。
- `npx vue-tsc -b` — エラー 0
- **本 work が足したテストは 8 件**（前 work着地時点 5685 → 5693。うち web-ui 単独 2035→2043）。

**AC の再判定**: AC1・AC2 は「本来通すべきケース」（`ended:true`）が引き続き通ることを
確認（退行なし）。AC5 は既存の順序 A テスト（`ended` 無しの `closed`）に加え、
**新たに追加した「諦めたあとの notice 保持」テストも同じ精神で緑**。AC7 は既存フレークも
含め 0 failed。

**変異による確認（ラウンド 3 で追加）**:

```
$ # T3/T4 の ended===true 条件を外す（T8 差し戻し前の状態に戻す）
     × 諦めたあと、同じ口から遅れて届いた transport 原因の `closed` で諦めの文言が消えない
      Tests  1 failed | 40 skipped (41)

$ # acceptsLifetimeSignal を第 2 項単体に縮める（再入テストで検証）
     × 飛行中の代表の試行自身の口から届いた closed でも安全にはしごを畳む
      Tests  1 failed | 41 skipped (42)
```

**起動確認（ラウンド 3）**:

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45201)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）

- **実機（`.env.verify`）での確認は行っていない**（requirements の対象外に明記済み）。
  「CLOSING のソケットでも配送される」は前 work の読解で裏を取っただけで、本 work も同様。
- skipped 41 件（環境依存。前 work と同数で本 work が増やしていない）。
- **既存フレーク**（`tab-visibility.test.ts`）は本 work では直していない（backlog の別項目）。
- **「転送が生きている場合」のシナリオはテストしていない**（`decisions.md` D5 の判断どおり）。
- 本 work が backlog へ意図的に残した項目（VT・プリンターの `onClose`／`openSession` の Promise
  settle）は前 work から引き継いだままで、本 work では解消していない。
