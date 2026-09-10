# テスト結果: セッション寿命の 4 規則を 1 か所ずつに畳む

## 実行したもの

- `npm test`（全 workspace） — **ラウンド2: 5664 passed / 0 failed / 41 skipped**（review 差し戻し後の再実行）
  - **ラウンド1: 5663 passed / 1 failed / 41 skipped**（合計 5705）。落ちた 1 件は下記の除外対象フレークで、
    ラウンド2 では出なかった（並列実行のタイミング依存であることの傍証）
  - ベースライン **5560 passed / 0 failed / 41 skipped**（本 work の design 工程で実測）＋**新規 104 件** = 5664。
    うち 1 件が下記の除外対象フレークとして failed 側に回っているため、passed は 5663。
    **skipped は 41 のまま増えていない。**
  - パッケージ別: base 52 / ebcdic 100 / hostserver 991 / scs 41 / server 1416(+3 skip) /
    tn3270 254(+38 skip) / tn5250 584 / vt 202 / web-ui 2013(+1 failed) / gen-tables 10 /
    hostserver-check 0（テストファイル無し）
  - 新規 104 件の内訳: サーバー組合せ表 65 ＋ サーバー走査 5 ＋ クライアント組合せ表 28 ＋
    クライアント走査 5 ＋ D9 の回帰テスト 1
- `npm run lint` — **exit 0**（`packages/web-ui/**` は `eslint.config.js` の `ignores` に入るため対象外）
- `npm run build`（`tsc -b` ＋ web-ui の `vue-tsc`） — **exit 0**
- `aidev smoke`（`node launcher/smoke.mjs`） — **pass (exit 0)**

## 受け入れ基準ごとの判定

- **AC1: pass**（review ラウンド1 の must を直したのち） — 定義は 4 規則とも 1 つに定まった
  （R1 `HolderState` / R2 `HoldState` / R3 `SessionLink`＋`Resumability` / R4 `Attempt`）。
  状態はいずれも判別可能 union。
  **導出の戻り値も列挙された状態にした**——`isResumable`（真偽）を `resumeVerdict`（`{resume:true}` /
  `{resume:false, why}`）に変え、`startReconnect` が `s.resumability` を読み直して門1 を再評価していた
  写しを消した（**D21**。同値性は全分岐で確認）。
  `isCurrentAttempt` は `boolean` のままだが、呼び出し側 3 箇所とも純粋なガードで
  組み合わせ直していないため AC1 が防ぐ失敗は起きていない（review の nit として記録）。
- **AC2: pass** — 走査テスト 2 本（サーバー 5 本 / クライアント 5 本）と、型による封じ込め
  （`connected` / `reconnect` / `reconnectFailed` を読み取り専用アクセサにして代入を型エラーにした）。
  **5 通りの死角すべてで違反が赤くなり、違反ファイル名が出ることを実測**（D16）。
  `settled`（D15）と `holdTimer`（D18）は定義の先に正当に残るので「0 件」ではなく封じ込めの形。
  **限界**: 分割代入はサーバー側 3 本を素通りする／`\.holder\b` は R1 の `holder` と
  予約者の表示名を区別しない（requirements が改名を対象外としているため）。
- **AC3: pass** — ラウンド2 は**除外なしで全数緑**（5664 / 0 failed）。ラウンド1 で落ちた
  `tab-visibility.test.ts` の 1 件は下記の既存フレークで、AC3 が判定から除くと定めているもの。
  lint 0・build 0・smoke pass。**既存テストの期待を緩めた箇所は 0 件**（根拠は次節）。
- **AC4: pass** — 共有表 `packages/web-ui/test/session-lifetime-matrix.ts`（サーバー 64 行 /
  クライアント 20 行 / 門の順序 2 行）から**サーバー・クライアント双方が回る**。
  `clientViewOf()` の射影で両向きに突き合わせ、片側にしか無い行が生まれたら落ちる。
  期待値は**畳み込みの前に HEAD `90f5636f` の実装から採取**してある。
- **AC5: 条件つき pass** — 4 規則とも変異で表が落ちることを確認した。ただし **R1 と R4 は
  design が指定した「項ごとの変異」が等価変異**で 0 件だったため、規則が読む所（R1）／
  規則そのもの（R4）を壊す形に差し替えた（**D17**）。実測値は下記。
- **AC6: pass** — `SessionManager` の公開面の変更は **`disposition()` の追加 1 件のみ**
  （HEAD との署名 diff で確認。削除・シグネチャ変更ゼロ）。WS プロトコルの定義
  （`packages/server/src/ws-messages.ts`）は**未変更**。
- **AC7: pass** — 前 work の判断 6 件（D4 / D5 / D7 / D10 / D12 / D13）が、いずれも
  `session-lifetime.ts` または `session-link.ts` のコメントから「前 work の D<n>」の形で辿れる。
- **AC8: 未** — backlog の消し込みは deliver 工程（T14）で行う（`decisions.md` D6）。

### AC5 の実測（計測スコープ＝ AC4 の表 2 本）

| 規則 | 入れた変異 | 落ちた件数 |
| --- | --- | --- |
| R1 | `session-lifetime.ts:146,238` の `held` の読みを `true` に（design 指定の形） | **0（等価変異）** |
| R1 | 同 `:185` `decideDisposition` の `i.hasHolder` を `true` に | 6 |
| R2 | 同 `:165,193` の `hold.holding` の読みを反転（design 指定の形） | 4 |
| R3 | `session-link.ts` `resumeVerdict` の読みを潰す（design 指定の形） | 5 |
| R4 | 同 `:186` の `!a.settled` を `!false` に（design 指定の形） | **0（等価変異）** |
| R4 | 同 `:186` を `return true;` に | 1（＋スコープ外の既存 1） |

R1 の 0 は `!prev.held` が隣の `prev.token !== token` に包含されるため、R4 の 0 は
`current === a && a.settled` が到達しないため（詳細と論証は `decisions.md` D17）。
**`releaseHolder` の門を丸ごと真にすると 22 件落ちる**ので、表がその経路を通っていないわけではない。

### AC3 の根拠 (a): 呼び出しの形だけを直した既存テスト

変更した既存テストは **48 本**。うち `expect(...)` の行が変わったのは **3 本だけ**で、
残り 45 本は**組み立ての形だけ**（`connected: false` → `link: { state: "lost", cause: "transport" }`、
`as SessionState` → `createSessionState({...} as unknown as SessionStateInit)`、
`attachedOnly` → `resumability`）。機械的な確認方法:

```
$ git diff -U0 -- '*test*' | grep -E '^[+-][^+-]' | grep -c 'expect('
```
をファイルごとに取り、0 でないものだけを目視した。3 本の中身は次のとおりで、**いずれも緩めていない**。

| ファイル | 変更 | 判定 |
| --- | --- | --- |
| `packages/server/test/ws-reconnect-resume.test.ts` | `expect` 3 行が**追加のみ**（削除なし） | D9 の回帰テストの新規追加。既存の期待は不変 |
| `packages/web-ui/test/session-reconnect.test.ts` | `s.attachedOnly === true` → `s.resumability === "not-resumable"` | 同義（旧フラグの改名先） |
| 同 | `s.endedByHost` の `toBeFalsy()` → `s.link` の `toEqual({state:"lost",cause:"transport"})` | **より強い**（falsy → 完全一致） |
| `packages/web-ui/test/status-input-state.test.ts` | 入力の組み立てが `{connected:false}` → `{link:{...}}` | 期待側（`toContain("切断")`）は不変 |

### AC3 の根拠 (b): AC3 の判定から除いた 1 件

`packages/web-ui/test/tab-visibility.test.ts` の
「全タブを畳んでもワークスペースに居られ、バッジは全数を出す」が **5000ms タイムアウト**で落ちた。

- **再現条件**: 並列実行（`npm test` の既定）でのみ落ちる。**単体実行では 8 件とも緑**（下記）。
- **本件と無関係である根拠**:
  - このテストファイルは**本 work で変更していない**（`git status --short` が空）
  - import しているのは `stores/workspace.js` と `paneLabels.js` の 2 つだけで、
    **どちらも本 work は触っていない**（触ったのは `session-controller.ts` /
    `stores/sessions.ts` / 新規 `session-link.ts`）
  - `.aidev/backlog/session-lifecycle.md:15` に**既存フレークとして起票済み**
    （「CI の並列度かこのテストのタイムアウトを見直す（本件とは無関係の既存フレーク）」）
- requirements AC3 が「この 1 件だけは判定から除く／黙って再実行で通さない」と定めているため、
  **除外した事実をここに残したうえで AC3 を pass とする**。他のテストは 1 件も落ちていない。

## 失敗の証跡

`npm test`（並列・既定ワーカー数）の生出力:

```
     × 全タブを畳んでもワークスペースに居られ、バッジは全数を出す 5091ms
Not implemented: navigation to another Document
Not implemented: HTMLCanvasElement's getContext() method: without installing the canvas npm package
Not implemented: HTMLCanvasElement's getContext() method: without installing the canvas npm package

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/tab-visibility.test.ts > 畳んだタブグループのタブも「開いている」 > 全タブを畳んでもワークスペースに居られ、バッジは全数を出す
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ test/tab-visibility.test.ts:125:3
    123|  */
    124| describe("畳んだタブグループのタブも「開いている」", () => {
    125|   it("全タブを畳んでもワークスペースに居られ、バッジは全数を出す", async () => {
       |   ^
    126|     const { mount } = await import("@vue/test-utils");
    127|     const { nextTick } = await import("vue");
```

単体で走らせると通る（**再現条件の確認であって、これで合格にはしていない**）:

```
$ cd packages/web-ui && npx vitest run test/tab-visibility.test.ts
 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  2.57s (transform 1.69s, setup 61ms, import 63ms, tests 1.93s, environment 422ms)
```

これ以外に失敗したケースは無い。

## 起動確認（smoke）

```
smoke: 20260908-session-lifetime-rules-fold
$ node launcher/smoke.mjs
{"level":40,"time":1789012426140,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789012426161,"host":"127.0.0.1","port":45575,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 45575)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

**GO**。`/healthz` が `{"status":"ok","sessions":0}` を返し、`/` が Web UI を返すところまで到達している。
本 work は**新しい入口（サブコマンド・オプション）を足していない**（既存の判定を畳んだだけで、
公開面の変更は `SessionManager.disposition()` の追加のみ）ので、`smokeCommands` への追加は行わない。

## 未検証の穴（skip / 環境不足）

deliver の PR 本文「既知の制約」へ引き継ぐもの:

1. **skipped 41 件**（`server` 3 / `tn3270` 38）。ベースラインから増減していないので本 work 由来ではないが、
   **green だが全数検証ではない**。中身は実機・環境依存のもの。
2. **`tab-visibility.test.ts` の並列フレーク**（上記）。AC3 の判定からは除いたが、CI では落ちうる。
3. **review ラウンド1 の must 修正が独立のタスク点検を経ていない**（T9 / T9-2 は点検ラウンド上限を
   使い切っている）。同値性は全分岐で自分で確かめ、review ラウンド2 で見る（**D21**）。
4. **走査が守らない範囲が 3 つある**（同一ファイル内の再計算 / 分割代入 / `link` の読み）。
   design「AC2 の詳細」に明記し、1 つ目は follow-up として T14 で backlog へ回す。
5. **実機での確認をしていない。** 本 work は単体テストと型のみで、
   `.env.verify` を使った実機の瞬断・繋ぎ直しは通していない
   （backlog `session-lifecycle.md:13` に前 work から積み残っている項目）。
   **畳んだのは判定の置き場所だけで振る舞いは変えていない**が、それを実機で確かめてはいない。
6. **R4 の `error` 経路が未被覆**（`session-controller.ts:465` のガード）。
   AC4 の表にも既存テストにも無い。`lifetimeOf`（R1 の孤児寿命）も AC4 の表が覆っていない
   （server 全体では `session-reconnect-grace.test.ts` の 3 件が落ちる）。いずれも D17 の積み残し。
7. **既存バグ D13 を直していない**——繋ぎ直しに成功したあと `opened` の枝がガード用の Map を消すため、
   以後の全メッセージが弾かれて画面が固まる。**HEAD でも再現する本 work 由来でないバグ**で、
   requirements の指示に従い直さず記録した。T14 で backlog へ起票する。
8. **review へ上げる文書と実装のずれ**: D17（AC5 の変異指定）/ D19（畳めなかった写し 1 件）/
   D20-3（未実施の改名 `idleLimitOf` → `lifetimeOf`）。
   D20-1（AC2 の対象集合）と D20-2（AC1 の戻り値の形）は review ラウンド1 で解消済み。

## ラウンド 2（review 差し戻し後の再実行・2026-09-10T04:35:00Z）

review ラウンド1 の must（AC1 / R3）と should 4 件を直したのち、全数を取り直した。

```
$ npm test
（集計）passed=5664 failed=0 skipped=41
$ npm run build
BUILD_EXIT=0
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 45269)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

**このラウンドでは失敗が発生していない**（ラウンド1 で落ちた `tab-visibility.test.ts` も出なかった。
並列実行のタイミング依存であることの傍証だが、**出なかったことを「直った」とは扱わない**
——backlog の既存フレークのまま残す）。

ベースライン 5560 ＋ 新規 104 = **5664** と一致。skipped は 41 のまま。
