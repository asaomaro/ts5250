# 決定記録

## D1: マクロエンジンを `macro-record.ts` と `macro-engine.ts` の 2 ファイルに分けた

- 背景: spec / plan では web-ui 側の追加を `macro-engine.ts` 1 ファイルとしていた。
  しかし実装すると**循環 import になる**——記録は `session-controller.sendKey` から
  「呼ばれる」側、再生は `sendKeyWithFields` を「呼ぶ」側なので、1 ファイルにまとめると
  `session-controller ⇄ macro-engine` の相互参照ができる。
  ESM の live binding では動くが、初期化順に依存する脆い構造になる。
- 決定: 依存の向きで割る。
  - `macro-record.ts` … 記録＋状態ヘルパ。**ストアにしか依存しない**（`session-controller` を import しない）
  - `macro-engine.ts` … 再生。`session-controller` と `macro-record` に依存する
  これで `session-controller → macro-record` / `macro-engine → session-controller` の
  一方向になり、循環が構造的に起きない。
- 理由 / 代替案: 代替案は (a) 登録フック（`setMacroRecordHook`）を置く、(b) 循環のまま許容する。
  (a) は import 副作用に依存して「どこかで import しないと記録が効かない」という
  見えない前提を作る。(b) は動くが、初期化順の変化で壊れたときに原因が分かりにくい。
  ファイル境界を依存の向きに合わせるのが最も単純で、壊れようがない。
- 影響: spec の「対象範囲」表に挙げた追加ファイルが 1 つ増える（3 → 4）。
  外部インターフェース（公開関数のシグネチャ）は spec のまま変更なし。

## D2: 再生専用の送信口 `sendKeyWithFields` を追加した

- 背景: spec では再生も `sendKey` を呼ぶと書いていた。しかし `sendKey` は送信内容を
  `s.edits`（`Map<number, string>`）から組み立てる。**秘密は値ではなく参照（`secretRef`）を
  送る**必要があるため（spec D11）、`Map<number, string>` には載せられない。
- 決定: `session-controller.ts` に `sendKeyWithFields(sessionId, key, cursor, fields, sysReqText)` を
  追加し、再生はこちらを使う。`fields` は「値」または「秘密参照」のタグ付き union（`WsKeyField`）。
- 理由 / 代替案: 代替案は `s.edits` の値型を union に広げること。だが `edits` は
  `ScreenGrid` の文字編集が読み書きする**ホットパス**で、型を広げると編集側すべてに
  分岐が波及する（受け入れ基準 A8 の非回帰リスクが跳ね上がる）。再生は編集を経ない別経路なので、
  送信口を分けるほうが影響が閉じる。
- 影響: `sendKey` の既存挙動は不変（記録フックが 1 行増えるだけで、`idle` では即 return）。
  再生は `s.edits` を触らないため、再生中にユーザーの打ちかけを壊さない副次効果もある。

## D3: 記録フックを `sendKey` の**送信前**に置いた

- 背景: 「送信後に記録する」ほうが「実際に送れたものだけ記録する」意味では自然に見える。
- 決定: 送信**前**に `recordSend()` を呼ぶ。
- 理由: 送信後だと、サーバーからの新画面が先に届いて `sessionsStore.updateScreen` の
  `edits.clear()` が走り、**記録すべき値が消えている**ことがある（`sessions.ts:129`）。
  送信前なら `s.edits` と `s.snapshot` が確実に対応している。
  なお `busy` プロテクト（`if (!s || s.busy) return`）の**後**に置いているので、
  弾かれた送信は記録されない＝「送っていないものを記録する」ことにもならない。
- 影響: なし（テスト `busy 中の送信は従来どおり弾かれ、記録も積まれない` で固定）。

## D5: 再生中の手入力ブロックを `session-controller` 側に置き、GUI 選択も対象に含めた

- 背景: test 工程で**実際の欠陥を検出**した。spec のエッジケース
  「再生中にユーザーが手で打鍵 → 再生中は入力を受け付けない」を、`blocksManualInput()` として
  実装はしたが**どこにも配線していなかった**。再現テストを書いたところ、
  応答が返ってから次のステップを送るまでの**隙間で `busy` が false になる**ため、
  その瞬間の `F3` がホストへ抜けることを確認した（`sent` に `["Enter", "F3"]` が並んだ）。
- 決定: `sendKey` / `selectGuiChoice` / `submitGuiSelection` の 3 つの入口で
  `blocksManualInput()` を見て弾く。再生は `sendKeyWithFields` を使うので巻き添えにならない。
- 理由 / 代替案: 代替案は `EmulatorPane` 側（キーハンドラ）で弾くこと。だが送信経路は 6 か所あり、
  凡例ボタン・ホイール・OIA ボタンを取りこぼす。`session-controller` は**送信の絞り**なので、
  ここに置けば構造的に漏れない（記録フックを同じ場所に置いたのと同じ理由）。
  spec は AID だけを挙げていたが、GUI 選択（`gui-select` / `gui-submit`）も
  ホスト側セッション状態を変えるため対象に含めた（spec からの拡張）。
- 影響: 休止中（`playPaused`）は**通す**——「毎回入力する」欄でユーザーが値を打ってから
  再開する動線を塞がないため。`blocksManualInput` が `playing` のみ true を返すのは意図的。

## D4: フィールド index が 1 始まりであることをテストの前提に明示した

- 背景: 実装中、`ScreenSnapshot.fields[].index` が 0 始まりだと仮定したテストを書いて
  `FIELD_NOT_FOUND` で落ちた。`core/src/screen/types.ts` の `Field.index` は
  「snapshot 時点の連番（**1 始まり**・画面順）」。
- 決定: マクロのテストは実データ（signon 画面 = index 1 ユーザー欄 / index 2 パスワード欄）に
  合わせ、その旨をコメントで残す。スキーマ側は `nonnegative()` のまま緩く受ける
  （`setField` が存在しない index を弾くため、二重に狭める必要がない）。
- 影響: テストのみ。実装の挙動に変更なし。
