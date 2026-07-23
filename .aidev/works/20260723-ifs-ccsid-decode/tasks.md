# タスク: IFS テキストの CCSID 決定表

## core（プロトコル・接続・codec）

- [x] T1: `ifs-datastream.ts` に `replyDatastreamLevel()` を足す（交換属性応答 0x8009 の offset 22）。
      実測の 38 バイト応答を使ったテストを添える
- [x] T2: `ifs-datastream.ts` に `buildListAttrsByHandleRequest(handle)`（属性リストレベル 0x44）と
      `parseContentCcsid(reply, dsl)`（可変部の CP 0x000F を辿り、DSL で 126/142/134 を切り替え）を足す。
      実測の OA2 応答 194 バイトで 850 が取れること・OA2 が無い応答で undefined になることをテストする
- [x] T3: `IfsConnection` に `datastreamLevel` を保持し（connect の交換属性応答から）、
      `readTextFile(path): { data, ccsid? }` を足す（依存: T1, T2）。
      1 ハンドルで open → ListAttrs → read → close。**OA2 が失敗しても読み取りは続ける**
- [x] T4: `packages/core/src/codec/ccsid-text.ts` を新規作成。`canDecodeCcsid` /
      `decodeCcsidText` / `encodeCcsidText` / `TEXT_CCSIDS` と、行末（lf / nel）の判定・復元を実装する

## server（決定表と HTTP）

- [x] T5: `packages/server/src/ifs-text.ts` を新規作成。決定表（手動 → BOM → UTF-8 → タグ）の純関数と
      その単体テスト（依存: T4）
- [x] T6: `/api/host/ifs/read` に決定表を配線し、応答に `ccsid` / `detectedBy` / `newline` / `tagCcsid` を載せる
      （依存: T3, T5）。`base64` 要求では OA2 を引かない。`TOO_LARGE` の判定順序は変えない
- [x] T7: `/api/host/ifs/write` に `ccsid` / `newline` を受けて符号化する。`substituted` を応答に載せる（依存: T5）

## web-ui

- [x] T8: `ifsApi.ts` の `IfsReadResult` を拡張し、`readFile` / `writeFile` に `ccsid` / `newline` を通す
      （依存: T6, T7）。新しい error code を `KNOWN_ERROR_CODES` と `messageFor` に足す
- [x] T9: `usePreview` に採用文字コード（`ccsid` / `detectedBy` / `newline` / `tagCcsid`）を保持させ、
      指定 CCSID での再読み込みを行えるようにする（依存: T8）
- [x] T10: `IfsPane.vue` に採用文字コードの表示と手動切替を足す。`UNSUPPORTED_ENCODING` のときも
      選択できるようにし、保存は読んだ `ccsid` / `newline` で送る（依存: T9）

## 検証

- [x] T11: `tools/hostserver-check` に IFS のタグ取得を確かめるコマンドを足す（依存: T3）。
      research のスパイクを、繰り返し使える形にして残す
- [ ] T12: 実機（PUB400）で往復を確認する（依存: T10, T11）。EBCDIC ファイルの表示・編集・保存と、
      819 / 1208 の既存ファイルが退行していないこと
