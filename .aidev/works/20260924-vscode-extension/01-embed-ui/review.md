# レビュー記録

## タスク点検ログ（coding 工程内・「3.3」(b)）

- [should][conv:-] `packages/web-ui/src/EmbedApp.vue`（旧・修正前）emulatorの再接続時
  （設定フォーム保存後の`connect`更新）に前のセッションを`closeSession()`で畳まずに
  `sessionId`を上書きしていた。サーバー側に孤児セッションが残る / 対応: 修正済（cross・
  `01-embed-ui`自己点検）
- [nit][conv:-] `packages/web-ui/src/stores/embed.ts`（旧・修正前）
  `window.addEventListener("message", ...)`が送信元を検査していなかった。JSDocは
  「拡張ホストが送ったものとみなせる」と断定していたが根拠が無かった / 対応: 修正済
  （`event.source === window.parent`を追加。コメントも実際の信頼境界—直接の親フレームか
  まで、`127.0.0.1`到達性由来の限界は残る—に即して書き直した。cross・`01-embed-ui`自己点検）
- [nit][conv:-] `packages/web-ui/src/embed.ts`: `main.ts`から初期化順（`initTheme`→
  `initViewSettings`）を写したが、順序に依存がある旨のコメントを落としていた / 対応: 修正済
  （T4・delegated点検）
- [nit][conv:test-input-shape!] `packages/web-ui/src/stores/embed.ts`:
  `connect`/`saved`の`payload`・`saveError`/`fileInvalid`の`message`の形（shape）を
  検査せず、`type`一致だけで`embedStore`へそのまま書き込んでいた / 対応: 修正済
  （`isConnectPayload`ガード・`message`の`typeof`検査を追加。回帰テストも追加。T4・delegated点検）
- [should][conv:-] `packages/web-ui/src/EmbedApp.vue`: `connect`の`watch`ハンドラに
  再入防止が無く、`openSession()`解決前に次の`connect`/`saved`が来ると二重に開き、
  後着ちの結果で`sessionId`が上書きされて先勝ちのセッションが孤児化しうる
  （`composables/openConfigured.ts`の`if (connecting.value) return;`と同種の欠落） /
  対応: 修正済（`connecting.value`チェックを追加。回帰テストも追加。T6・delegated点検）
- [nit][conv:-] `packages/web-ui/src/EmbedApp.vue`: `payload.host !== ""`だけが他の
  フィールドと違う扱い（`!== undefined`）で、意図の説明も無かった（`host`は`ConnectPayload`で
  必須のためこの特例は不要） / 対応: 修正済（無条件で`open.host = payload.host`に統一。
  T6・delegated点検）
- [nit][conv:-] `packages/web-ui/src/EmbedApp.vue`: `restTarget`のfeature選択が三項演算子の
  連鎖（elseで受ける書き方）で、`EmbedAppKind`に種別が増えても気づけない
  （AGENTS.md「型で分岐を閉じる」） / 対応: 修正済（`Record<Exclude<EmbedAppKind,"emulator">,
  string>`のキー網羅に置き換え。T6・delegated点検）

## ラウンド 1（2026-09-25T00:32:00Z）

被覆（`aidev coverage`）: gap 0（struct=0, cover=0）。tasks承認時（8タスク・AC 14件）と
比べて増えていない（design/tasksとの乖離なし）。

**要件適合・価値適合**（work全体の文脈。taskcheckの射程外なのでここで見る）:
- このsubtask単体ではUS1の価値（VSCode内で完結する）は実現しない
  （実際にVSCode拡張機能へ載せるのは02-extension-core）が、**次工程への前提を崩さない
  形で正しく積み上げている**——`embed.html`が実際にサーバーから配信されること・
  `openSession()`との接続経路（emulator直結 / 他はsystem参照）がdesign.mdの訂正後の
  記述と一致することを実機で確認済み（test-result.md）
- test-result.mdのAC1判定が「pass」とだけ書かれていて、実際は「Web-UI/サーバー側のみ
  確認・VSCode WebView表示は未検証」という部分合格だった。過大な主張
  （protocol.md「主張は証拠の範囲を超えない」）——review工程で気づき、test-result.mdを
  「partial pass」に訂正済み

**規約適合・保守性**: taskcheck（T1〜T8・cross）で計7件の指摘を検出・修正済み
（内訳: should 2・nit 5。上記「タスク点検ログ」節）。review時点の再点検で新規の
must/should は見つからなかった。

指摘なし（このラウンドではmust/should 0件。上記test-result.mdの表現訂正のみ実施）。
