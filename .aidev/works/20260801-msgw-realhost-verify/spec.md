# 仕様: メッセージ本文をサーバー CCSID で読む

`research.md` F6 で見つけた欠陥の修正。検証そのものは実装変更を要さなかった
（`answerMessage` の NUL 終端は**そのまま受理された**）。

## 設計方針

### D1: メッセージの CCSID はサインオンが申告した値を使う

`NetPrintConnection.connect` は既に `signon()` を呼んでおり、`serverCcsid` を得ている。
それを `messageCcsid` として保持し、`retrieveMessage` の文字列復号に渡す。

**SCS の CCSID（`opts.ccsid`）とは別物**なので混ぜない——SCS はスプールの中身の文字コードで、
メッセージはジョブの文字コード。既定値も違う（SCS は 273、メッセージは 37）。

### D2: `decodeNpString` の既定は 37 のまま（後方互換）

`decodeNpString(raw, ccsid = MESSAGE_CCSID)` と省略可能にする。
既存の呼び出し（`errorFromReply` のメッセージ組み立て）は挙動を変えない
——**この work で確かめたのは `retrieveMessage` の経路だけ**なので、
確かめていない経路を巻き込んで変えない。

### D3: 「ID では気づけない」ことをテストに書く

**英数字はどの CCSID でも同じに読める**。だから `CPA3394` は化けずに本文だけ壊れる。
この非対称をテストで明示する（次に触る人が「ID が読めているから CCSID は合っている」と
誤解しないように）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/hostserver/src/spool/netprint-connection.ts` | `messageCcsid` を保持し `retrieveMessage` で使う。`decodeNpString` に ccsid 引数 |
| `packages/hostserver/test/netprint-message.test.ts` | CCSID の 4 ケースを追加 |
| `scripts/research-msgw.mjs` | 新規（実機の再現） |

## 受け入れ基準との対応

requirement の完了条件に一対一（結果は `test-result.md`）。
