# レビュー（03-web-ui-dtaq）

subtask 単独のレビュー。**最大の risk は一覧の SQL 組み立て（インジェクション）**なので、
独立レビュー（別エージェント）を dtaqApi.ts・DtaqPane.vue・登録 4 箇所に当てた。

## ラウンド 1（独立レビュー + 自己レビュー）

### SQL インジェクション — 悪用不可（検証済み・指摘なし）

独立レビューで end-to-end に追跡:
- 正規表現 `/^[A-Za-z0-9$#@_.]{1,10}$/` は `'` `\` `;` 空白を除外。Db2 の文字列リテラルは `'` でしか
  終端せずバックスラッシュエスケープも無いので、通過する入力ではリテラルから抜け出せない。
  `$ # @ _ .` はリテラル内で無害。
- `assertObjectName` は library/name の**両方**に、埋め込み前に効いている。`.toUpperCase()` は新文字を生まない。
- 検証を迂回して `listEntries` に届く経路は無い（関数冒頭で検証／UI も `queueReady` で二重ガード）。

### must: なし

### should（2 件）＋ low（1 件）——**このラウンドで修正・再検証済み**

- **S1 `listEntries` が ok を見る前に json を parse**（`dtaqApi.ts`）。プロキシ等が非 JSON（HTML の 502/504）を
  返すと `res.json()` が生の SyntaxError を投げ、日本語文言を通らず漏れる。
  **修正**: `post()` と同様、`res.ok` を先に見て json は `.catch` で握る。
- **S2 `onDelete` が失敗時も表示を畳む**（`DtaqPane.vue`）。`act` はエラーを内部で握るため、
  削除失敗（使用中など）でも直後の `attrs/entries` クリアが走り、**まだ在るのに「消えた」ように見える**。
  **修正**: `act` を使わず明示 try/catch にし、**成功時だけ**畳む。回帰テスト追加。
- **L1（low）`onClear` が clear 成功後の refresh 失敗でメッセージを出さない**（`DtaqPane.vue`）。
  **修正**: clear が通った直後に message を立てる（`listEntries` は message を触らないので消えない）。

### 独立レビューで確認済み・指摘なし

- **recvWait**: 負値はクライアントで `Math.max(0,…)`、大きい値はサーバーで `Math.min(…, receiveMaxWaitSec)`。無限待ちは作れない。
- **KEYED create**: `keyLength` は KEYED のときだけ送る。
- **messageFor / KNOWN_ERROR_CODES**: 完全一致。`b.error` はどのエラー経路でも埋まる。
- **列名の写像**: SQL 別名（POS/DATA_EBCDIC/BYTES/HEX64/ENQUEUED/SENDER）と読み取りキーが一致。
  `pageSize` 応答形（rows / error・code）も `listEntries` の期待と一致。
- **他ハンドラに同種の潜在バグ無し**（message を立ててから reset する経路は onClear だけで、それは修正済み）。
- **登録 4 箇所が整合**: `dtaq:` prefix・ラベル・FEATURE id `dtaq:entries`・WorkspaceNode の import/computed/分岐がすべて揃う。

## 結果

- must 0 / should 2 / low 1（いずれも修正・再検証済み）/ nit 0
- web-ui 541 passed、lint / vue-tsc / vite build クリーン
- 実ブラウザ E2E 7/7 を再確認（修正後も happy path は不変）
