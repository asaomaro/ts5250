# 仕様: `pendingAid` の解決条件を「Read 要求」に一本化する

## 概要

`packages/tn5250/src/session/session.ts` の `handleRecord()` が `pendingAid`
（`sendAid()` の Promise、`key-done` メッセージの元）を「`unlockKeyboard` が立った最初の
レコード」で解決している（research.md F4）ため、DSPFMT のように「キーボード解放だけ先に行い、
複数の Write to Display で内容を埋めていく」応答で、まだデータが埋まっていない画面が
`key-done` として送られてしまう。`this.state = "ready"`（`onceReady` 含む）も同じ
`unlocked` フラグで遷移しており、同じ理由で早すぎる遷移をしうる（research.md「design への
申し送り」1点目）。

修正方針: **`unlockKeyboard` 単独ではなく、`readRequested`（実際に Read コマンドが来たこと）を
「この応答の受信が完結した」ことの唯一の判定基準にする。** `unlockKeyboard` はその名の通り
「キーボードのロック状態」だけを表す独立したビットであり、「ホストがこの応答を完結させ、
入力を待っている」ことの判定には使えない、という事実を反映する。

## 設計方針

現状 `handleRecord()` はローカル変数 `unlocked`（`result.unlockKeyboard` から立てる）を使い、
(a) `this.state = "ready"`／`onceReady()` の起動、(b) `pendingAid` の解決、の**両方**を
制御している。**`"screen"` イベントの `keyboardLocked` は `buf.snapshot()` に渡す
`this.keyboardLocked`（`get keyboardLocked() { return this.state !== "ready"; }`、
`session.ts:262-267`）から**導かれるため、(a) の `this.state` 遷移タイミングが
`keyboardLocked` の値をそのまま左右する——`unlocked`／`this.state`／`keyboardLocked` は
3つの独立した仕組みではなく、1本の依存の鎖である。

これを次のように変える: **ローカル変数を1つのまま残し、それが立つ条件を
`result.unlockKeyboard` から `result.readRequested` に切り替える**（変数名も
役割に合わせて `readSolicited` に改める——「Read が要求された」という新しい意味を
`unlocked` という名前のまま残すと紛らわしい）。この1つの変数で (a)(b) 両方を
制御する構造自体は変えない。

**(a) も含めて切り替える理由**（research.md の申し送り事項への回答）:
`this.state === "ready"` は `sendAid()` の `assertReady()`（Attn/SysReq 以外の通常 AID キーの
送信可否）を左右する。`unlockKeyboard` だけで "ready" にしてしまうと、DSPFMT のような
複数レコード応答の**まだ途中**（骨格だけの画面）でも新しい AID キーを送れてしまう——
`packages/server/src/ws-handler.ts` の `onKey()` は WS メッセージを直列化しない
（`app.ts:335` の `void conn?.handle(data)`、`ws-handler.ts:1007-1009` のコメント「ws は
1 通ずつ独立に処理される」）ため、ブラウザ側から続けて2つのキー操作（例: 素早い連続
Enter、または MCP 自動操作と人間操作の重なり）が来るとこのタイミング窓を実際に踏みうる。
`readSolicited` に統一することで「ホストが本当に入力を待っている」ことと「新しい AID を
送ってよい」ことが一致し、この副次的なリスクも合わせて解消する。
**Attn/SysReq はこの変更の影響を受けない**（`sendAid()` は Attn/SysReq を `assertReady()` の外で
扱っており、`this.state` を見ないため——research.md のリスク検討時に確認済み）。

**副次的な改善（意図した変更ではないが、正しい方向への副作用）**: 上記の依存の鎖により、
DSPFMT のようなケースで `"screen"` イベントの `keyboardLocked` も、従来は骨格だけの
1レコード目から `false`（解錠）になっていたのが、修正後は実際に Read が来る最終レコード
まで正しく `true`（施錠）のまま保たれるようになる——`packages/web-ui` の 🔒 表示・busy
インジケータ（`session-controller.ts` の `applyDisplayMessage`、`!msg.screen.keyboardLocked`
で busy を解除する箇所）がより正確な状態を反映するようになる。この副作用の目視確認は
本開発環境では出来ない（`requirements.md` 非機能要件の通り）が、web-ui 側のロジック自体は
変更しないため、既存の回帰リスクは無い。

### 代替案として検討し、採らなかったもの

- **`pendingAid` の解決だけを `readRequested` ベースにし、`this.state`/`onceReady` は
  `unlockKeyboard` のままにする**: 変更範囲が狭く安全に見えるが、上記の「ready なのに
  応答未完結」という不整合な状態が残る。狭い変更で済ませる利点よりも、概念の一貫性
  （"ready" の意味を1つに保つ）を優先した。
- **`unlockKeyboard` が立った時点で少し待ってから（例: 1 tick）解決する**: タイミング
  依存のワークアラウンドに過ぎず、`research.md` F7 で確認した「TCPセグメント分割次第で
  何レコード分待てば十分か決まらない」という不確実性を解消しない。根本原因
  （`unlockKeyboard` と「応答完結」を同一視していること）に対処する方が確実。

## 対象範囲

- `packages/tn5250/src/session/session.ts`: `handleRecord()`（`unlocked` を
  `readSolicited` に改める判定・`this.state`遷移・`pendingAid` 解決部分）。
- `packages/tn5250/test/`: 新規回帰テスト（複数レコードに分かれた応答を合成し、
  `sendAid()` が最終レコードまで解決を待つことを検証する）。

## 依拠する既存の事実

- `handleRecord()` の現状の実装、`unlocked` の宣言・使用箇所:
  `packages/tn5250/src/session/session.ts:578, 698-710`（T1 実装後の行番号。coding 時の
  横断点検で design 起草時点の行番号からずれていることが判明し、review 工程で更新した）。
- `ApplyResult.readRequested`/`unlockKeyboard` の生成条件:
  `packages/tn5250/src/protocol/wtd-applier.ts:253-263`（Read コマンド、両方同時に立つ）、
  `:314-315`（`applyCc2`、`CC2_UNLOCK` ビットのみで `unlockKeyboard` が独立に立つ）。
- `sendAid()` の `assertReady()`/Attn・SysReq の扱い:
  `packages/tn5250/src/session/session.ts:334-335`（Attn/SysReq は `assertNotClosed()` のみ、
  他は `assertReady()`）。
- `handleClose()` が `pendingAid` を安全にフォールバック解決すること（Read が来ないまま
  セッションが終わっても `pendingAid` はハングしない）:
  `packages/tn5250/src/session/session.ts:738-747`（T1 実装後の行番号。
  research.md のリスク欄への回答として確認）。
- DSPFMT の応答が3レコードに分かれ、1・2番目が `unlockKeyboard=true, readRequested=false`、
  3番目だけが両方 true になること: research.md F3（実機トレース + 自プロジェクトの
  ビルド成果物を直接呼んで確認）。
- 単体テストで複数レコード応答を合成する既存の書き方（`ReplayTransport`/
  `DeferredTransport`、`buildRecord`/`ByteWriter` での手組み）:
  `packages/tn5250/test/sendaid-cursor-sync.test.ts`（全文読解済み）。
- `"screen"` イベントの `keyboardLocked` が `this.state` から導かれること:
  `packages/tn5250/src/session/session.ts:262-267`
  （`get keyboardLocked() { return this.state !== "ready"; }`、`snapshot()` がこれを
  `buf.snapshot()` へ渡す。本 doccheck ラウンド1の指摘を受けて直読）。
- 「Read の無いレコードでは `this.readCommand` を上書きしない」既存の区別:
  `packages/tn5250/src/session/session.ts:653-656`（T1 実装後の行番号）。
- WS メッセージが直列化されず、1通ずつ独立に処理されること:
  `packages/server/src/app.ts:335`（`void conn?.handle(data)`）、
  `packages/server/src/ws-handler.ts:1007-1009`（`onKey()` のコメントと
  `timeoutMs: "never"`。本 doccheck ラウンド1の指摘を受けて直読）。
- `sendAndWait()` の `timeoutMs` 指定時のタイムアウトフォールバック
  （`pendingAid` を `timedOut: true` で解決する既存の仕組み）:
  `packages/tn5250/src/session/session.ts:442-448`（本 work 冒頭で直読、本 doccheck
  ラウンド2の指摘を受けて「依拠する既存の事実」に追記）。

## インターフェース / データ構造

変更なし。`sendAid()` の戻り値の型（`SendAidResult`）・`Session5250` の公開 API は
一切変更しない——`handleRecord()` 内部の解決条件（いつ resolve するか）だけを変える
振る舞いの修正であり、シグネチャの変更を伴わない。

## 振る舞いの詳細

`handleRecord()` の該当部分（擬似コード。実際の変数名・配置は `research.md` A1/A2 の
アンカーに従う）:

```
// 旧: let unlocked = false;
// 新: 変数名を役割に合わせて改める。立つ条件も unlockKeyboard から readRequested へ変更。
let readSolicited = false;   // 「ホストがこの応答を完結させ、入力を待っているか」

// (try 節内、各コマンド処理のあと)
// 旧: if (result.unlockKeyboard) unlocked = true;
if (result.readRequested) readSolicited = true;

// (try 節を抜けたあと)
if (readSolicited) {                  // 旧: if (unlocked)
  this.state = "ready";               // → keyboardLocked（"screen"イベント。session.ts:262-267）
  this.onceReady?.();                 //   もこの遷移から導かれるため、同じ切り替えで
  this.onceReady = undefined;         //   Read が来るまで正しく施錠されたままになる
}
const snap = this.snapshot();
this.emit("screen", snap);            // 変更なし: 毎レコード必ず発火（"screen" イベント自体は
                                       // 従来通りレコードごとの進捗を伝える）
if (readSolicited && this.pendingAid) {   // 旧: if (unlocked && this.pendingAid)
  const p = this.pendingAid;
  this.pendingAid = undefined;
  clearTimeout(p.timer);
  p.resolve({ screen: snap, timedOut: false });
}
```

**`if (result.lockKeyboard && this.state === "ready") this.state = "locked";`
（既存、683行）は変更しない**——これは「一旦 ready になった後、次の AID 応答の**先頭**で
再ロックする」ためのもので、`readSolicited` への切り替えとは独立に動作する
（`this.state` が "ready" になるタイミングが変わるだけで、ロジック自体は影響を受けない）。

## ドメイン固有の考慮

- 5250 プロトコルにおいて、1回の AID キー送信に対する応答が複数レコードに分かれることは
  仕様上許容されている（`research.md` F3 で実機確認）。「キーボード解放」と「入力の
  読み取りを実際に要求すること（Read コマンド）」は独立したビット/概念であり、
  後者だけが「ホストがこの応答を完結させた」ことの信頼できる合図になる
  （`session.ts:653-656` の既存コメントが、`this.readCommand` を「Read の無いレコードでは
  上書きしない」形で既にこの区別を暗黙に踏まえている——本修正はこの認識を `pendingAid`/
  `this.state` にも一貫させるもの）。

## エラー処理 / 異常系

- **Read が一度も来ないまま、ホストが接続を切る場合**: `handleClose()`
  （`session.ts:738-747`）が `pendingAid` を `timedOut: true` で解決する既存の仕組みが
  そのまま効く（本修正で変更しない）。ハングしない。
- **Read が一度も来ないまま、`sendAndWait()` のタイムアウト（`timeoutMs` 指定時）に達する
  場合**: 既存の `setTimeout` フォールバック（`session.ts:442-448`）がそのまま効く
  （変更しない）。ただし web-ui 経由（`ws-handler.ts` の `onKey()`）は `timeoutMs: "never"`
  を使うため、このフォールバックには到達しない——その場合は上記の `handleClose()` か、
  最終的に Read が来ることが唯一の解決経路になる（`research.md` のリスク検討の通り、
  `sendAid()` を呼べる状況では Read が来ることが前提になっている設計のため、これは
  許容する）。

## 受け入れ基準との対応

- AC1: 修正後に `scripts/diag-dspfmt-ws-e2e.mjs` を実行し、罫線のみで終わるケースが
  0件であることを確認する（test 工程で実施）。
- AC2: 修正後に `scripts/diag-dspfmt-reconnect-blank.mjs`（`sendAid()` の解決値を
  直接チェックする形に改修済み——`decisions.md` D1）を再実行し、修正前は複数回中
  すべてで再現していた不具合が、修正後は複数回中すべてで解消していることを確認する
  （test 工程で実施。コア層のみでの discrimination）。
- AC3: 本ファイルが設計判断（`readRequested` への一本化、`this.state`/`onceReady` も
  含める理由）を記録している。追加の理由（Attn/SysReq が影響を受けないこと等）が
  `decisions.md` にあれば併記する。
- AC4: `packages/tn5250/test/` に、`sendaid-cursor-sync.test.ts` と同じ手法
  （`DeferredTransport` + 手組みレコード）で、(1) 1レコード目（unlock のみ、read 無し）を
  届けても `sendAid()` が未解決のままであること、(2) 2レコード目（read 付き、実際のデータ）を
  届けると初めて解決し、かつ解決される画面が2レコード目の内容を反映していること、を
  検証するテストを追加する。
- AC5: `npm run test -w @ts5250/tn5250`（既存テスト全件）を実行し、回帰が無いことを
  確認する。

## テスト方針

- 上記「振る舞いの詳細」に対応する単体テスト（実機不要）を1本追加する。
- 実機診断（`scripts/diag-dspfmt-*.mjs`）は test 工程で AC1/AC2 の確認に使う
  （自動テストスイートには含めない——既存の diag スクリプトと同じ扱い）。
