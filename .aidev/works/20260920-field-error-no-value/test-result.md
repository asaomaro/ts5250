# テスト結果: 欄の検証エラーが値をブラウザへ返さないようにする

## 実行したもの

> **ラウンド 3（review 差し戻し 2 回目）の再実行結果に更新済み**。
> 件数は差し戻しのたびに増えている（server 1442 → 1444 → 1446、web-ui 2118 → 2122）。

- `npm test`（リポジトリ全体） — **1 件の既存 flake を除き緑**
  - `@ts5250/base` 52 passed / `@ts5250/ebcdic` 100 passed
  - `@ts5250/hostserver` 991 passed
  - `@ts5250/scs` 41 passed
  - `@ts5250/server` **1446 passed / 3 skipped**
  - `@ts5250/tn3270` 254 passed / 38 skipped
  - `@ts5250/tn5250` **694 passed**
  - `@ts5250/vt` 202 passed
  - `@ts5250/web-ui` **2121 passed / 1 failed**（下記「未検証の穴」の既存 flake）
  - launcher 10 passed
- `npm run build`（`tsc -b`） — pass
- `npm run build -w @ts5250/web-ui`（`vue-tsc -b tsconfig.json tsconfig.test.json` ＋ vite） — pass
  （**web-ui は `test/` も型検査の対象**。`AGENTS.md`「ビルド・テスト」）
- `npm run lint`（`eslint .`） — pass（0 件）
- `aidev smoke` — **pass (exit 0)**
- web-ui は**パッケージ dir から**も実行（`cd packages/web-ui && npx vitest run`。`AGENTS.md` の指定どおり）

この work で増えたテスト: tn5250 +5（689 → 694）、server +8（1438 → 1446）、web-ui +11（2111 → 2122）。

## 受け入れ基準ごとの判定

- **AC1**（`message` に値が 1 文字も含まれない・3 経路）: **pass**
  `packages/tn5250/test/field-validate.test.ts` が数値専用 / 英字専用 / DBCS 専用 / コードページ外の
  4 経路で「値を含まない」「位置と理由が入る」を検査。**値に固有の記号と長さも出ない**ことまで見る
  （英数字は文言そのものと重なるので、そこは `toBe` で文言を丸ごと突き合わせて担保する）。
- **AC2**（ws の `error` に値が含まれない）: **pass**
  `packages/server/test/ws-macro-secret.test.ts` の 5 件。マクロの `secretRef` を
  **数字専用欄**（`digitsOnlyTrace()`）へ再生して **FIELD_TYPE で弾かれること**を確かめたうえで、
  平文・平文の一部・平文の長さのいずれも返らないことを見る。
  桁あふれ（`FIELD_OVERFLOW`）の経路も別途 1 件。
- **AC3**（位置と理由が含まれ、日本語・定数 1 か所）: **pass**
  `packages/tn5250/test/field-error-position-wiring.test.ts` が **`Session.setField` 経由で
  実際の欄の位置が入る**ことを固定（欄を動かすと文言も動くことまで）。
  web-ui 側は `field-keystroke-rules.test.ts` と `field-at-contract.test.ts`。
  文言は `opMessages.ts` の定数を参照（`MSG_UNKNOWN_ERROR` を export して直書きを解消）。
- **AC4**（ログにも値が出ない）: **pass** — `packages/server/test/err-shape.test.ts` の 9 件。
- **AC5**（戻すと落ちるテスト）: **pass** — 下記「変異注入の結果」。
- **AC6**（例外の一覧）: **pass** — `decisions.md` D4（棚卸しの表）＋ D5（長さの扱いを寄せた）
  ＋ D8・D10（review で見つかった漏れ 2 件を追記）。
- **AC7**（緑・定数参照）: **pass** — 上記のとおり。
- **AC8**（秘密・固有名詞なし）: **deliver で消化**（T10）。
- **AC9**（クライアント文字列の反射なし・**欄を書く経路に限る**）: **pass**
  ——**ラウンド 4 まで経路を書かずに「pass」と書いていたのは事実と違った**
  （`AGENTS.md` 判断の原則 3。主張を証拠の範囲に戻した）。
  利用者の判断で **AC9 の範囲を欄の経路に限定**し、残りは requirements の「対象外」＋台帳へ送った
  （decisions D11）。この範囲での判定は次のとおり:
  D4 の 4 か所すべてにテストが付いた（点検前は 1 か所だけだった）。3270 側の双子 2 か所も同時に塞いだ。
  **review でさらに 6 経路が見つかり、そちらも塞いだ**——`fields[].field` の素通し（D8）、
  `macro <id> not found`（D10）、3270 の `applyFields`（要素がプリミティブな形）、
  `gui-select` / `gui-submit` の `fieldId`、`fields` の容れ物（配列でない形）。
  検証は `packages/server/src/ws-field-ref.ts` に集約し、5250・3270 の両方で**同じ位置**で呼ぶ。

  **範囲外として残したもの**（decisions D11。台帳に起票済み）:
  `sessionId` / `watchId` / `session` / `system` / `host` の反射。
  送った本人に自分の識別子が返るだけで、秘密でも他人の値でもない。
  **実害のあった「表示の乗っ取り」は閉じてある**——`wsErrorNotice` が message の中身を見るのを
  欄の検証が出す code のときだけに絞った（`CODES_WITH_FIELD_DETAIL`）。

## 変異注入の結果（条項 `verify-by-mutation`・AC5）

**実装を元に戻すとテストが落ちる**ことを、修正ごとに 1 回ずつ確かめた。

| 戻した実装 | 落ちたテスト |
|---|---|
| `field-validate.ts` の文言に `JSON.stringify(value)` を戻す | tn5250 6 件 ＋ **server `ws-macro-secret` 2 件** |
| `session.ts` の `at`（第 5 引数）を渡すのをやめる | tn5250 `field-error-position-wiring` 3 件 |
| `wsErrorNotice` を `${head}（${message}）` に戻す | web-ui 4 件 |
| `session.ts` の `unsupported AID key: ${key}` を戻す | tn5250 `aid-key-no-reflection` 2 件 |
| `session.ts` の `sysReqText … (got ${key})` を戻す | 同上（2 件に含む） |
| `session-manager.ts` の `key ${key} not allowed …` を戻す | server 1 件 |
| `ws-handler.ts` の `invalid secretRef: ${…}` を戻す | server 1 件 |
| `tn3270-adapt.ts` の 2 か所を戻す | server `ws-tn3270` 3 件 |
| `buffer.ts` の `value length ${chars.length} …` を戻す | server 1 件 |
| `field-validate.ts` の `field at (…)` の書式を変える | web-ui `field-at-contract` 1 件 |
| **（ラウンド 2）** `ws-handler.ts` の `wsFieldRefSchema` の検証を外す | server 1 件（`欄の指定が壊れていても…`）|
| **（ラウンド 2）** 走査を自前の正規表現（行末コメントを落とせない版）に戻す | web-ui `field-at-contract` 1 件 |
| **（ラウンド 3）** `applyFields` の形の検査を `"value" in f` の後ろへ戻す | server `ws-tn3270` 1 件 |
| **（ラウンド 3）** `buffer.ts` の `FIELD_OVERFLOW` 側だけ書式を変える | web-ui `field-at-contract` 1 件 |

**この工程で見つけた「落ちないテスト」は 3 件**（いずれも cross 点検の指摘。`review.md`）:
点検前の `ws-macro-secret` は直した経路を通っておらず、`at` の配線はどこからも固定されておらず、
反射の 4 か所のうち 3 か所に検査が無かった。**`field-at-contract` の初版もコメントに当たって素通りした**
（コメントを落としてから走査する形に直した）。

## 失敗の証跡

**test 工程からの差し戻しは発生していない**（`npm test` は一度も赤にならなかった）。
**差し戻しは review から 2 回**——ラウンド 1 は `fields[].field` の素通し（D8）ほか、
ラウンド 2/3 は**その修正が 3270 で半分しか閉じていなかった**こと。
両方の生出力を下に残す。上表の他の失敗は**意図的に注入した変異**によるもの。

```
$ npx vitest run --root packages/server test/ws-macro-secret.test.ts
  × 型の合わない欄へ再生しても、error の message に平文が出ない 29ms
  × 平文の**一部**も返らない（先頭 1 文字・長さも出さない） 25ms
AssertionError: 復号した平文が返っていない: expected 'numeric field accepts digits only: "d…' not to contain 'dummy-secret-value'
 Tests  2 failed | 9 passed (11)
```

```
$ npx vitest run --root packages/server test/ws-macro-secret.test.ts
  × 桁あふれで弾かれたときも、平文の長さを返さない 32ms
AssertionError: 平文の長さも返さない: expected 'value length 18 exceeds field length …' not to contain '18'
 Tests  1 failed | 11 passed (12)
```

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":40,"time":1789886379081,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789886379120,"host":"127.0.0.1","port":45773,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 45773)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

**この work は新しい入口（サブコマンド・オプション）を足していない**ので `smokeCommands` は据え置き。

### review 差し戻し 1 回目の生出力（AC9 が本線で破れていた）

```
$ npx vitest run --root packages/server test/ws-macro-secret.test.ts
  × **欄の指定が壊れていても、クライアントが送った文字列を反射しない** 32ms
AssertionError: 反射している: "LEAK_MARKER_XYZ": expected 'Cannot use \'in\' operator to search …' not to contain 'LEAK_MARKER_XYZ'
 Tests  1 failed | 13 passed (14)
```

### review 差し戻し 2 回目の生出力（3270 で半分しか閉じていなかった）

**要素そのものがプリミティブ**な形を試していなかったので、2 ラウンド見逃していた。

```
$ npx vitest run --root packages/server test/ws-tn3270.test.ts
  × **欄の指定が壊れていても、クライアントの値を文言に反射しない** 7ms
AssertionError: 反射している: "LEAK_MARKER_XYZ": expected 'Cannot use \'in\' operator to search …' not to contain 'LEAK_MARKER_XYZ'
 Tests  1 failed | 17 passed (18)
```

## 既存の flake（この work の変更ではない）

`packages/web-ui/test/tab-visibility.test.ts` の
「全タブを畳んでもワークスペースに居られ、バッジは全数を出す」が
**全件実行のときだけ 5000ms でタイムアウト**する（単体実行では 8/8 緑）。

```
 FAIL  test/tab-visibility.test.ts > 畳んだタブグループのタブも「開いている」 > 全タブを畳んでもワークスペースに居られ、バッジは全数を出す
Error: Test timed out in 5000ms.
 Test Files  1 failed | 167 passed (168)
      Tests  1 failed | 2121 passed (2122)
   Duration  100.07s (transform 41.23s, setup 49.96s, import 91.73s, tests 268.90s, environment 555.04s)
```

**この work の変更ではないことを確かめた**——`git stash` で web-ui の変更をすべて外し、
新規テストも退避した**素の HEAD** で再現する（`1 failed | 2108 passed`）。
`.aidev/backlog/code-quality-checks.md` に起票した。
**「自分のせいではない」で済ませず、緑でないことは緑でないと書く。**

## 未検証の穴（skip / 環境不足）

- **実機での確認は行っていない。** この work が変えたのは**例外の文言**で、
  ホストへ送るバイト列は 1 バイトも変わらない（`setField` の検証は送信前に落とす層）。
  実機でしか分からない差が出る変更ではないと判断した——ただし「判断した」であって
  **実機で確かめてはいない**（`AGENTS.md` 判断の原則 2 に照らし、ここは穴として明示する）。
- **VT core（`packages/vt`）が投げる例外に打鍵内容が入るか**は未確認のまま
  （`decisions.md` D4 の「未確認として残す」。`onVtInput` / `onVtResize` 経由）。
- **非 `As400Error`（ソケットの errno 等）が実際にブラウザへ届くこと**は再現していない。
  コード上は `ws-handler.ts` の `String(err)` 分岐で通り、ホスト名・ポートが出うる。
  どちらも台帳へ引き継ぐ（deliver の PR 本文「既知の制約」に載せる）。
- `@ts5250/tn3270` の 38 件 / `@ts5250/server` の 3 件は元から環境依存で skip されているもので、
  この work が増やしたものではない。
