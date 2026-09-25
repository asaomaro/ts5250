# レビュー記録

## タスク点検ログ（coding 工程内・「3.3」(b)）

### T7: serviceManager.ts（delegated）

- [must][conv:-] `defaultSpawnServer`が返す`ChildProcess`に`"error"`リスナーが
  無かった。`spawn`自体が失敗すると未処理例外になり拡張ホスト全体を巻き込みうる /
  対応: 修正済（`child.once("error", reject)`をhealthz待ちと競走させ、
  `acquire()`の失敗として正しく伝播するようにした）
- [should][conv:-] `pid: child.pid ?? -1`のフォールバックが`killByPid`で無条件に
  `process.kill()`へ渡っていた。`kill(-1, sig)`はPOSIXで「権限があるすべての
  プロセスへブロードキャスト」という別の意味を持つ / 対応: 修正済
  （`killByPid`に`pid <= 0`のガードを追加）
- [should][conv:-] 複数ウィンドウが同時に起動を試みたときの「負けた側」が
  起動したプロセスは、どのロックファイルの`windows`からも参照されず孤児として
  残り続ける。design.mdの「ハートビートの陳腐化で自己終了する」という記述は
  誤りだった（陳腐化判定は`windows`に載っているエントリしか見ない） / 対応: 修正済
  （書き込み後に再読込みし、自分の書き込みが上書きされていたら自分の子プロセスを
  畳んで勝者のポートへ乗り換えるようにした。design.mdの記述も訂正）
- [nit][conv:-] `acquire()`が`ChildProcess`を呼び出し元へ渡す経路が無く、
  design.md「ログ」が求める「子プロセスのstdout/stderrをOutputChannelへ流す」が
  実装不能だった / 対応: 修正済（自分が新規spawnしたときだけ`{port, child}`を返すよう
  戻り値を拡張し、`extension.ts`側でOutputChannelへ配線した）
- [nit][conv:-] `waitUntilHealthy`内のhealthzタイムアウトが`1000`のマジックナンバーで、
  同じ値を持つ`HEALTH_CHECK_TIMEOUT_MS`と重複していた / 対応: 修正済（定数を参照）
- [nit][conv:-] `killByPid`のpid再利用リスク（陳腐化したpidが偶然別プロセスに
  再割り当てされている場合の誤kill）を指摘されたが、design.mdの「厳密な排他ロックは
  取らない」という単一利用者ローカルツールとしての方針の範囲内と判断し、
  対応不要（コメントで方針を明記した）

### T9: ts5250EditorProvider.ts（delegated）

- [should][conv:-] service起動失敗時の`failureHtml`が、design.mdが求める
  「OutputChannelへの誘導」を含んでいなかった / 対応: 修正済（出力パネルへの案内を追記）
- [should][conv:-] `handleSave`が「保存（WorkspaceEdit）自体の失敗」と
  「保存は成功したが、既存の壊れたpasswordEncを読めない」を同じ`saveError`型で
  混同していた。後者は書き込みが実際には成功しているのに、利用者には
  「保存に失敗した」という誤ったメッセージが届く / 対応: 修正済
  （`buildConnectPayload`はpasswordの復号に失敗しても呼び出し全体を失敗にせず、
  passwordを省いたペイロードを返す設計に変更。`saveError`は本当に保存操作が
  失敗したときだけ送るようにした）
- [nit][conv:-] `buildConnectPayload`の未使用`webview`引数に「将来systemRef解決
  （03-sql-ifs）で使う」という推測的な正当化コメントが付いていたが、
  03-sql-ifsの実際の設計（HTTP経由でのsystem登録）ではWebviewオブジェクト自体は
  不要と考えられ、単なる死んだ引数だった / 対応: 修正済（引数を削除。要る時が来たら
  そのときに足す）
- [nit][conv:test-input-shape!] `save`メッセージの`payload`の形を検査せずに
  `handleSave`へ渡していた。`null`等が来ると`values.host`で例外を投げ、
  `onDidReceiveMessage`へ渡した非同期コールバック（誰も待っていない）の
  未処理rejectionになりうる / 対応: 修正済（`isSettingsFormValues`で最低限の形を
  検査してから渡すようにした）

### T10: extension.ts（same_session。unit test作成中に自己発見）

- [must][conv:-] `releaseService`が`Math.max(0, localCount - 1)`してから0判定して
  いたため、対応する`acquireService`が無い状態で`releaseService`を呼ぶと
  （`localCount`が既に0）誤って下位の`serviceManager.release()`を呼んでしまっていた
  （「既に0だった」と「1から0になった」を区別できていなかった） / 対応: 修正済
  （`localCount === 0`なら即returnするガードを先頭に追加。回帰テスト追加）
- [must][conv:-] `acquireService`が`localCount++`した直後に下位の
  `serviceManager.acquire()`が失敗（例外）すると、`localCount`が増えたまま戻らず、
  以後どのパネルを閉じても0に到達せず実体のサーバープロセスが永久に止まらなくなる
  （`Ts5250EditorProvider`は`acquireService`が失敗した経路で`releaseService`を
  呼ばない設計のため、対になる減算が永久に来ない） / 対応: 修正済（失敗時に
  `localCount--`してから再throwする。回帰テスト追加）

## ラウンド 1（2026-09-25T01:08:00Z）

被覆（`aidev coverage`）: gap 0（struct=0, cover=0。`ac=14 design=14/14 tasks=14/14`）。

**要件適合・価値適合**:
- design.mdが訂正2箇所（対象範囲の「packages/server変更なし」・複数ウィンドウ調停の
  「孤児プロセス自己終了」の誤り）を含めて実装と整合する状態になっている
  （`decisions.md` D1・D2、design.md本文の取り消し線）
- AC3（実際の接続）を実機で直接検証済み（test-result.md）。`WsOpen`直接指定経路が
  spawnしたサーバー経由で機能することを、モックではなく実際のIBM iへの接続で確認した

**規約適合・保守性**: taskcheck（T1〜T10・cross）で計14件の指摘を検出・修正済み
（must 3・should 5・nit 6）。すべて`review.md`「タスク点検ログ」に記録済み。
このラウンドの再点検で新規のmust/shouldは見つからなかった。

**AGENTS.md規約の確認**:
- ログ: `console.*`は不使用（`vscode-extension/`にも該当箇所なし）。子プロセスの
  出力はOutputChannelへ配線
- 秘密: 平文パスワードのファイル書き込み・ログ出力箇所は無い（grep確認済み。
  test-result.md参照）
- `.gitignore`: `vscode-extension/node_modules`・`dist`は既存のグローバルパターンで
  カバー済み（新設不要）
- ESM/CommonJS: `vscode-extension/`だけCommonJSでコンパイルする（VSCode拡張ホストの
  制約。ESM拡張のmainエントリは2026年9月時点でも未対応——WebSearchで確認済み）。
  この逸脱の理由が`tsconfig.json`に書かれていなかった

- [nit][conv:comment-provenance!] `vscode-extension/tsconfig.json`の`module: "CommonJS"`が
  リポジトリ全体のESM規約からの意図的な逸脱であるにもかかわらず、その場に理由が
  書かれていなかった（設計時の判断はdesign.mdにもtsconfig.jsonにも残っておらず、
  読み手が「書き忘れ」と「意図的」を区別できない状態だった） / 対応: 修正済
  （`tsconfig.json`冒頭にコメントを追加）

上記1件（nit）以外、このラウンドでは新規のmust/shouldは見つからなかった。
