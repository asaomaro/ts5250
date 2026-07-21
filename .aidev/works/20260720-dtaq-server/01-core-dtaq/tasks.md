# タスク: core データ待ち行列（01-core-dtaq）

親 spec.md / design.md を継承。research の spike（`dtaq-datastream.ts` /
`dtaq-connection.ts` / `port-mapper.ts` / `tools/hostserver-check/src/dtaq.ts`、
いずれも未コミット）を**正式化**する。ゼロから書くのではない。

## トランスポート改修（後方互換が最優先）

- [x] T1: `HostConnection.request(frame, opts?: { readTimeoutMs?: number })` を足す。
  この 1 往復だけ `socket.setTimeout(readTimeoutMs)` を設定し、resolve/reject の
  両方で `defaultTimeoutMs` に戻す（design 判断 1）。`readTimeoutMs: 0` で無効（無限待ち）。
  **`opts` 省略時は一切触らない**（signon/SQL/IFS/command は従来どおり 20 秒）。
- [x] T2: T1 の後方互換をユニットテストで固定。偽サーバー（既存の FakeTransport 系の作法）で
  (a) `opts` 省略時は 20 秒のまま (b) `readTimeoutMs` 指定時はその往復だけ変わり次で戻る
  (c) `readTimeoutMs: 0` でタイマー無効、を検証。**既存の transport テストが全て通ること**。

## 型の切り出し（browser 共有）

- [x] T3: `dtaq/dtaq-types.ts` を新規作成し、`DtaqEntry` / `DtaqAttributes` /
  `ReadOptions` / `SearchOrder` / `CreateOptions` の純粋な型を移す（datastream/connection は
  そこから import）。`@as400web/core/browser` から参照できる配置にする（server 応答型・web-ui 共有のため）。

## dtaq の正式化

- [x] T4: `dtaq-connection.ts` の `read` で wait → readTimeoutMs を写す（design 判断 2）。
  `wait < 0` → `readTimeoutMs: 0`（無限）、`wait >= 0` → `(wait + 10) * 1000`。
  `this.conn.request(buildRead(opts), { readTimeoutMs })` を渡す。
- [x] T5: `rawRequest`（spike 用の露出）を削除。`onRawFrame` の research フックも削除して
  `read` を綺麗にする。`requestAttributesFrame` も T6 の `attributes()` に置き換えて削除。
- [x] T6: `attributes(name, library): Promise<DtaqAttributes>` を実装。
  0x0001 を送り 0x8001 応答を解く。レイアウトは **coding 中に実機採取して確定**
  （宣言長から導かない。maxEntryLength@22, saveSender@26, type@27 下位4bit, keyLength@28 は原典の仮定）。
  `parseAttributesReply` を datastream 側の純粋関数として追加しテスト可能にする。
- [x] T7: `dtaqFailure(what, rc, messageId?)` を `dtaq-datastream.ts` に追加（design 判断 4）。
  共通応答 0x8002 の CPF メッセージ（offset22 の LL/CP、CPFxxxx を EBCDIC デコード）から
  rc + CPF ID を `As400Error` に写し分ける（NOT_FOUND/ACCESS_DENIED/ALREADY_EXISTS/CONFIG_ERROR/
  その他 PROTOCOL_ERROR）。`0xF006` はエラーにしない（read で undefined）。
  connection の `dtaqError`/`assertSuccess` をこれに置き換える。
- [x] T8: T7 の rc→コード写像をユニットテストで固定（偽の 0x8002 フレームを組んで各分岐）。
  受信応答パース `parseReadReply`・各ビルダの固定バイト列テストも datastream 単体で追加
  （実機ダンプ research.md F2 を固定データに使う）。

## 実機検証（spike ツールで採取）

- [x] T9: `tools/hostserver-check/src/dtaq.ts` を拡張し、spike 未検証の項目を実機採取:
  LIFO 順序、キー付き（write with key → key 検索 EQ/NE/LT/LE/GT/GE）、clear、
  `attributes()` の 0x8001 生バイト（T6 のレイアウト確定に使う）、無限待ちが transport 改修で通ること。
  QSYS2 の SQL サービス（`DATA_QUEUE_ENTRIES` / `DATA_QUEUE_INFO`）と突き合わせる。都度片付ける。

## 仕上げ

- [x] T10: `index.ts` / `browser.ts` の export を整理（`DtaqAttributes` 追加、spike で仮に出した
  ものの精査）。`npm run -w @as400web/core test` と lint / build がクリーン。
