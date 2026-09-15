# 調査: DSPFMT 等、複数レコード応答での初回表示が罫線のみになる不具合

## 調査の問い

- Q1: 利用者が報告した「DSPFMT FILE(ASAOLIB/COMPLIST) OUTPUT(*)」実行時の「罫線のみ表示→Enter
  で正常化」は、`@ts5250/tn5250` のプロトコル解析コアで再現するか。
- Q2: コアで再現しない場合、`packages/server`（ws-handler）・`packages/web-ui` のどちらの層で
  再現するか。
- Q3: 再現する場合、根本原因はどこにあるか（file:line で特定する）。
- Q4: 利用者が申告した「再接続や寸断への対応の後に発生している可能性がある」は事実か。

## 判明した事実

- F1: **`Session5250.snapshot()`（ライブのバッファ状態を都度読む API）を毎回ポーリングする
  診断（`scripts/diag-dspfmt-reconnect-blank.mjs`、本 work で作成、web-ui/server 層を
  経由しない）では、`DSPFMT FILE(ASAOLIB/COMPLIST) OUTPUT(*)` を6回実行して6回とも
  正常に見えた（実行ログ: 本 research 実施時の標準出力）。**この結果は誤誘導だった**
  ——F1'（下記）の通り、`session.snapshot()` はいつ呼んでも常に最新のバッファ状態を
  返すため、3つのレコードが届き終わった後にポーリングすれば正しい内容しか観測できない。
  この診断は「バッファの中身が最終的に壊れるか」しか確認できておらず、本件の実際の欠陥
  （F1' 参照）を捉えられていなかった（当初 F1 として「コア層では再現しない」と誤って
  結論づけた——`doccheck requirements` ラウンド1の指摘で発覚し訂正）。
- F1': **`sendAid()` が返す Promise の解決値（`res.screen`）を直接調べる診断
  （本 research で追加実行、`Session5250` 直結・web-ui/server 層を経由しない）では、
  `DSPFMT FILE(ASAOLIB/COMPLIST) OUTPUT(*)` に対する `sendAid("Enter")` の解決値が
  **8回中8回、罫線のみの画面（バグそのもの）だった**——同じ瞬間の `session.snapshot()`
  （ライブ）は8回とも正常。**これはコア層（`packages/tn5250`）だけで100%決定的に
  再現する欠陥であり、web-ui・server 層は一切関与しない。** F4 で特定した原因
  （`pendingAid` が `unlockKeyboard` の最初のレコードで解決してしまうこと）が
  そのまま実証された。
- F2: **`packages/server`（ws-handler）を実サーバーとして起動し、ブラウザと同じ `/ws`
  プロトコルで接続する診断（`scripts/diag-dspfmt-ws-e2e.mjs`、本 work で作成）では、
  8回中5回、最終的にブラウザが受け取るメッセージ列の到達順の結果として罫線のみの画面が
  残った（再現）。** 残り3回は正常。うち2回（試行#3, #5）は「一度データありの状態を経てから
  罫線のみに戻る」——利用者が申告した「一瞬罫線以外の内容が見えてから消える」と一致する
  症状も観測できた（実行ログ: 本 research 実施時の標準出力）。**F1' との関係**: コア層の
  欠陥（`sendAid()` の解決値が常に罫線のみ）は F1' の通り 100% 決定的に起きるが、それが
  **利用者に見える最終表示**として現れるかどうかは、ブラウザ側が受け取る `"screen"`
  （正しい最終画面、レコードごとに同期送信）と `"key-done"`（`sendAid()` の解決値＝
  罫線のみ、Promise 解決を経て非同期送信）の**到達順序という別のタイミング依存**に
  左右される（F7）。**したがって「原因はコアにある」ことと「利用者側の見え方が時々正常に
  見える」ことは矛盾しない**——コアの欠陥は常時発生するが、その影響がユーザーに見える
  形で顕在化するかどうかは web-ui/server 層のメッセージ到達順という別の変数で決まる。
  F1' の発見により、本 work の修正対象はコア層（`packages/tn5250`）だけで確定し、
  `packages/server`/`packages/web-ui` 側の変更は不要と判断する（`requirements.md`
  「対象外」）。
- F3: DSPFMT の応答は**3つの5250レコード**に分かれて届く（`scripts/_tmp-decode-dspfmt.mjs`
  で `parseRecord()`+`applyDataStream()`（`packages/tn5250/dist/protocol/{gds,wtd-applier}.js`）
  を直接呼んで各レコードの `ApplyResult` を確認。デコンパイル済みコードではなく、
  当プロジェクト自身のビルド成果物を使った確認）:

  | # | バイト数 | opcode | unlockKeyboard | readRequested | readCommand |
  |---|---|---|---|---|---|
  | 0 | 267 | 0x02(PUT/GET系) | true | **false** | undefined |
  | 1 | 134 | 0x02 | true | **false** | undefined |
  | 2 | 464 | 0x03(SAVE/RESTORE系) | true | **true** | 82 (0x52) |

  1つ目・2つ目のレコードは「Write to Display で WCC の CC2_UNLOCK ビットだけ立てて
  キーボードを解放するが、Read コマンドを伴わない」もの
  （`packages/tn5250/src/protocol/wtd-applier.ts:315`
  `if ((cc2 & CC2_UNLOCK) !== 0) result.unlockKeyboard = true;`）。3つ目だけが
  READ_MDT_FIELDS 系のコマンドを伴い（同ファイル253-263行）、`readRequested=true` と
  `cursorSet=true`（実際のカーソル位置指定）が同時に立つ。**これが罫線のみ→データ表示の
  正体**——1つ目・2つ目のレコードで骨格（罫線・入力欄の枠）だけが描かれ、3つ目で見出し・

  **単一レコードで完結する応答（大多数のケース）への影響は無い**: 同ファイル253-263行の
  通り、READ_MDT_FIELDS 系のコマンドは常に `readRequested` と `unlockKeyboard` を
  **同じレコードの同じ処理内で同時に**立てる（`result.readRequested = true;` の3行後に
  `result.unlockKeyboard = true;`）。したがって、応答が1レコードで完結する（Read
  コマンドを伴うレコードがそのまま唯一のレコードである）場合、`unlockKeyboard` を見ても
  `readRequested` を見ても**同一レコードの同一呼び出しで**真になり、解決タイミングは
  変わらない。タイミングが変わりうるのは DSPFMT のように「Read を伴わない
  Write to Display が Read 付きレコードより先に届く」構成の応答だけである。
  `COMPLIST` の行データとカーソル位置が確定する。
- F4: **根本原因は `packages/tn5250/src/session/session.ts` の `handleRecord()`
  （529-695行）が、`pendingAid`（`sendAid()` が返す Promise）を「`unlockKeyboard` が
  立った最初のレコード」で解決してしまうこと**（688-694行、`if (unlocked &&
  this.pendingAid) { ...p.resolve({ screen: snap, timedOut: false }); }`。`unlocked` は
  668行付近で `if (result.unlockKeyboard) unlocked = true;` として立てられ、F3の1つ目の
  レコード（罫線の骨格だけ、`readRequested=false`）で既に真になる）。DSPFMT のように
  「キーボードは先に解放するが、複数の Write to Display で内容を埋めていく」ホスト
  プログラムでは、`pendingAid` が**骨格だけの画面**で解決されてしまう。
- F5: `sendAid()` を呼ぶ側（`packages/server/src/ws-handler.ts` の `onKey()`、970-1018行）は
  `res = await entry.session.sendAid(...)` の結果を `key-done` メッセージとして
  ブラウザへ送る（1015行 `this.send({ type: "key-done", ..., screen: res.screen, ... })`）。
  F4 の通り `res.screen` は骨格だけの古い画面になりうる。
- F6: 一方、`session.on("screen", ...)`（`ws-handler.ts` 860-861行）は `handleRecord()`
  内で毎レコードごとに同期的に発火する `"screen"` イベント（`session.ts:688`
  `this.emit("screen", snap)`）をそのままブラウザへ push する（`onScreen = (screen) =>
  this.send({ type: "screen", screen })`）。3つのレコードそれぞれについて `"screen"`
  イベントが発火するため、正しい最終画面（3つ目のレコード由来）も別途ブラウザへ届く。
- F7: **`"screen"` イベントの送信は完全に同期**（`emit` → `onScreen` → `this.send` →
  `this.ws.send(JSON.stringify(...))`、`ws-handler.ts:1134-1136`）。一方 `"key-done"` は
  `sendAid()` が返す **Promise の解決 → `await` の継続（マイクロタスク）** を経て送信される
  （`onKey()` の `const res = await entry.session.sendAid(...)` の後）。**この非対称性が
  タイミング依存の原因**——3つのレコードが同じ Node の `'data'` イベント（同じ TCP セグメント）
  にまとまって届けば、`telnet.onRecord` のループが3回とも同期的に `handleRecord()` を呼ぶため
  （`session.ts:237`）、3つの `"screen"` が全て送信された**後**にようやくマイクロタスクが
  流れて `"key-done"`（骨格だけの古い画面）が送信される——**この場合、ブラウザに届く最後の
  メッセージが `"key-done"`（古い画面）になり、不具合が再現する**。逆に1つ目のレコードが
  単独の `'data'` イベントとして先に届き、そこで `pendingAid` が解決してマイクロタスクが
  （次の `'data'` イベントの前に）先に流れれば、`"key-done"`（古い画面）は2つ目・3つ目の
  `"screen"`（正しい画面）より**前**に届き、不具合は再現しない。TCP のセグメント分割は
  ネットワーク条件（利用者の申告する「再接続や寸断」を含む、RTT・輻輳・OSのバッファリング等）に
  左右されるため、**「ほとんど再現するが、まれに正常」という利用者の申告と一致する**。
- F8: `sessionsStore.updateScreen()`（`packages/web-ui/src/stores/sessions.ts:450-485`）は
  `"screen"`・`"key-done"` のどちらのメッセージでも無条件に `s.snapshot = snapshot` で
  上書きする（`session-controller.ts` の `applyDisplayMessage()`、572-597行、どちらのケースも
  `sessionsStore.updateScreen(sessionId, msg.screen)` を呼ぶ）。**メッセージの新旧・出処を
  判別する仕組みが無い**——F7 のとおり後から届いたほうが常に勝つ。
- F9: 利用者の申告「再接続や寸断への対応を行ってから発生している可能性がある」について:
  `packages/tn5250` のコア（`Session5250`）自体には reconnect ロジックが**存在しない**
  （`grep -rn reconnect packages/tn5250/src` はヒット0件）。再接続の概念があるのは
  `packages/web-ui/src/session-link.ts`（ブラウザ↔ローカルサーバー間の WebSocket 再接続）
  だけである。**F1' により、この仮説は反証されたと判断する**——コア層の欠陥
  （`sendAid()` の解決値が罫線のみになること）は、再接続の有無に関係なく**フレッシュな
  接続でも100%決定的に発生する**（F1'、8/8）。再接続ロジックのバグが原因なら発生に
  再接続という前提条件が要るはずだが、実際には前提条件無しで毎回起きる、より根本的な
  欠陥だった。**利用者が「再接続の後に起きた」と感じたのは、コアの欠陥が常に存在する中で、
  それが実際に画面へ現れるかどうかを左右する F7 のタイミング競合（TCPセグメント分割）が
  ネットワーク条件に左右され、再接続が起きるような不安定なネットワーク状況ではその競合が
  「罫線のみ」側に倒れやすかった、という**相関**が最も単純な説明である（再接続ロジック
  それ自体の欠陥ではない）。

## 影響範囲

- `packages/tn5250/src/session/session.ts`: `handleRecord()` の `pendingAid` 解決条件
  （688-694行）が直接の修正対象。
- `packages/tn5250/src/protocol/wtd-applier.ts`: `ApplyResult.readRequested`/`unlockKeyboard`
  は変更不要（F3 の値自体は正しい。両者を独立に扱っている設計は妥当——問題は
  `session.ts` 側がこの2つを同一視していること）。
- `packages/server`/`packages/web-ui`: F6〜F8 の無条件上書きロジック自体は、コア層
  （`pendingAid`）を直せば正しく動作する見込み（`"key-done"` が常に最終状態を運ぶように
  なるため）。design で「web-ui 側も直すべきか」を再検討する。
- 影響を受けるのは DSPFMT に限らない——**「Read を伴わない Write to Display で
  `unlockKeyboard` が立つ」ホストプログラム全般**（PDM のサブファイル更新、ウィンドウを
  段階的に開くプログラム等）が同種の症状を起こしうる。

## 実現性 / リスク

- 修正は `packages/tn5250` 内部（非公開ロジック）に閉じており、公開 API
  （`sendAid()` のシグネチャ）は変更不要と見込む（`design.md` で確定する）。
- リスク: `readRequested` を伴わない `unlockKeyboard` の後、**本当に Read が二度と来ない**
  経路が既存の他のホストプログラム・他のテストシナリオに存在した場合、`pendingAid` が
  永久に解決されなくなる（ハング）可能性がある。`buildAidRecord()`
  （`session.ts:389-422`）が `this.readCommand`（Read コマンドでしか更新されない、
  644-646行のコメント参照）に依存して応答形式を決めている以上、**そもそも Read が
  一度も来ない画面に対して `sendAid()` を呼ぶこと自体が想定されていない**——このリスクは
  設計上許容できる見込みだが、design で「フォールバック（タイムアウト等）を用意すべきか」を
  検討する。
- 既存の単体テスト（`packages/tn5250/test/`）は「1レコード = 1応答」を前提にしたものが
  大半と見込まれる（未確認——design/tasks 工程で該当テストを洗い出す）。

## 実装アンカー

- A1: `pendingAid` の解決条件（修正対象そのもの）:
  `packages/tn5250/src/session/session.ts:682-694`（`handleRecord()` 末尾、
  `if (unlocked) {...}` 〜 `if (unlocked && this.pendingAid) {...}`）。
- A2: `unlocked`/新設する `readRequested` 相当のローカル変数の宣言位置:
  `packages/tn5250/src/session/session.ts:568`（`let unlocked = false;`）。
- A3: `result.readRequested`/`result.unlockKeyboard` の生成元（変更不要、参照のみ）:
  `packages/tn5250/src/protocol/wtd-applier.ts:253-263`（Read コマンド）、`:315`
  （`CC2_UNLOCK` ビット）。
- A4: 回帰テストの追加先（未特定——design で判断。既存の関連テストを持つ
  `packages/tn5250/test/` 配下のファイル名は tasks 工程で洗い出す）。

## design への申し送り

- `pendingAid` の解決条件を「`unlockKeyboard` かつ `readRequested`」（＝実質
  `readRequested` 一本、F3の通り Read コマンドは必ず `unlockKeyboard` も同時に立てるため）
  に変更する案が本命。ただし:
  1. `this.state = "ready"`／`onceReady`（`unlocked` を使う既存のもう1つの分岐、
     682-686行）も同じ理由で早すぎる遷移をしている——**これも直すべきか**は design で
     判断する（本 work のスコープに含めるか、影響範囲が広がるので見送るか）。
  2. F9 のリスク（Read が来ない画面への対応）を、設計上どう扱うかを明記する。
  3. 修正後、`scripts/diag-dspfmt-ws-e2e.mjs` を複数回実行して再現ゼロを確認する
     （実機検証、design 承認後・coding 完了後に実施）。
- 合成レコードによる単体テスト（実機不要）を追加する。`packages/tn5250/test/` 内の
  既存テストの書き方（`Session5250` に直接バイト列を注入する形式のものがあれば参考にする）
  を tasks 工程で調査する。
