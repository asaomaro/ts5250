# レビュー: 01-core-listfiles

## ラウンド 1（差し戻し）

独立した第三者視点のレビューを実施。**must 5 / should 6 / nit 5**。
主要な指摘は実装者側でも再現・確認済み（下記に確認方法を記載）。

### must

**M1. `parseListEntry` が奇数長のファイル名で生の `RangeError` を投げる**
`ifs-datastream.ts:365-374`。範囲チェックは `nameAt + nameBytes <= frame.length` を見るが、
復号ループは 2 バイトずつ `getUint16` で読むため、`nameBytes` が奇数だと最後の 1 回が範囲外に出る。

- **確認済み**: LL=11（名前 5 バイト）のフレームを作って実行 → `RangeError: Offset is outside the bounds of the DataView`
- 影響: `As400Error` ではないので `statusOf()` が分類できず、HTTP は 500 になる。
  さらに `requestStream` のコールバック内で飛ぶため接続まで毒化する
- 直し方: 同じガードで `nameBytes % 2 !== 0` も弾く

**M2. IFS の失敗がすべて `PROTOCOL_ERROR` に潰れ、502 に写る**
`ifs-connection.ts:245 / 282-285 / 291-297 / 313-318`、`server/host-api.ts:39-55`。

spec は rc=2/3 を 404、rc=13 を 403、rc=4 を 409 と決めているが、`statusOf()` に
`PROTOCOL_ERROR` の分岐は無く既定の **502** に落ちる。`host-api.ts` 自身のコメントが
「502 は上流との通信失敗に限る。設定の誤りや認可の失敗まで 502 にすると呼び出し側が区別できない」
と明言しており、**自分のコメントに違反する**状態。`statusOf` の戻り型には 409 すら無い。

- このままだと 02-server-api は `"no such directory:"` の文字列照合でしか spec を満たせない
- test-result.md は rc=13 を「コード上の対応のみで未検証」と書いたが、**そもそも rc=13 固有の処理は存在しない**。
  この記述は誤り。訂正する
- 直し方: `ErrorCode` に `NOT_FOUND` / `ACCESS_DENIED` / `ALREADY_EXISTS` を足し、core 側で投げ分ける
  （`SESSION_NOT_FOUND` / `FIELD_NOT_FOUND` の先例どおり、区別できるコードを持つのが本 PJ の作法）

**M3. `canContinue` のテストが本物の回帰テストになっていない**
`test/ifs-list.test.ts:174-202`。テスト側に**プロダクションの式をコピーして、そのコピーを検証**している。
本体のガード（`ifs-connection.ts:256-260`）を削除しても反転させても、4 件すべて緑のまま。

D6 が記録するとおり、このガードは実機で無限ループを起こしてから入れたもので、
**この変更で最も重要な振る舞い**。それが実質未テスト。

根本原因は構造。`IfsConnection` は private constructor と実ソケットを開く `static connect()` しか持たず、
偽の `HostConnection` を差し込めない。結果として **`listFiles` の中身は何一つ単体テストされていない**——
`.`/`..` の除外も、rc からの `hasMore` 導出も、D2 の核心である「除外前から `nextRestartId` を取る」ことも、
missing の経路も、失敗時の `close()` も。

- 直し方: 判定を純粋関数として `ifs-datastream.ts` に切り出してそれをテストする、
  および／または `HostConnection` を注入できる口を設けて連鎖ループを偽サーバーで駆動する
  （`host-connection-stream.test.ts` が偽サーバーの安さを既に示している）

**M4. 終端フレームで例外を投げるため、連鎖が終わっている接続まで毒化する**
`ifs-connection.ts:228-242`。`listReplyKind` は `0x8001` の未知 rc（13 / 1 / 5 など）を `"error"` にする。
しかし `0x8001` は**終端フレーム**で、後続は無い。にもかかわらずコールバック内で throw するため
`desynced` が立ち、接続が破棄される。

`missing`（`:219-222`）は `false` を返して**ストリーム完了後に**投げており、同じ形が使えるのに使っていない。

- 影響: design が定める `ifs-collect.ts`（1 接続で再帰的に集めて zip 化）で、
  **権限の無いサブディレクトリが 1 つあるだけで走査全体が死ぬ**。読み飛ばせない
- 直し方: `"error"` も `missing` と同様に扱い、`requestStream` 解決後に投げる。
  コールバック内 throw は `parseListEntry` の真の途中失敗（D5 が想定した状況）に限る

**M5. 追加した低水準エクスポート 9 個が未使用で、しかも根拠のコメントが事実に反する**
`index.ts:181-194`。「`tools/hostserver-check` の `ifs-list --raw` で使う」と書いたが、
`ifs-list.ts` が import しているのは `IfsConnection` と `Tn5250Error` だけで、
生フレームは `onRawFrame`（D3）から得ている。

- **確認済み**: `tools/` `packages/server/src` `packages/web-ui/src` を grep して 9 シンボルすべて **0 箇所**
- `export type { HostConnection }` は未使用というだけでなく、AGENTS.md が隔離している
  トランスポート層を公開 API に出してしまっている
- 逆に **02-server-api が実際に必要とする `IfsListOptions` は未エクスポート**。過不足が反転している
- これは「もっともらしい理由を付けて確かめない」の実例（memory: 辻褄が合うことは裏付けではない）
- 直し方: 9 個を削除し、`IfsListOptions` を公開する

### should

- **S1** `IfsEntry.restartId` のコメント（`ifs-types.ts:18-23`）が「打ち切られたときは最後のエントリのこの値を
  次の要求に渡す」と書いており、**D2 が防ごうとした誤用そのものを教えている**。
  `nextRestartId` の説明と矛盾する。「診断用。ページングには `IfsListResult.nextRestartId` を使う」に直すか、
  公開する型から落とす
- **S2** トランスポートの desync ガードが throw の経路しか覆っていない
  （`host-connection.ts:136-138`）。コールバックが終端前に `false` を返した場合、
  残りは `pending` 無しで届いて**黙って捨てられる**。次の要求を先に出せば、その応答として読まれる。
  このプロトコルに非同期通知は無い（同ファイルのコメント）ので、
  **対応要求の無いフレームの到着自体を desync の証拠として扱えば**塞げる
- **S3** 進行チェック（`ifs-connection.ts:256-260`）は「送った値がそのまま返る」1 種類しか検出しない。
  A→B→A→B の 2-cycle は素通り。コメントの「進んでいない場合は」は実装より広いことを主張している。
  単調増加で比較するか、コメントを実装に合わせる。またページ上限がツール側（`ifs-list.ts:137` の `page < 50`）
  にしかなく、実機で実際に必要だったガードがライブラリの外にある
- **S4** `maxCount` / `restartId` が未検証で黙って切り詰められる（`setUint16(at, 65536)` は 0 になる）。
  02-server-api 経由で JSON から来る値なので、ビルダで範囲を検証して `CONFIG_ERROR` にする
- **S5** 空パスがファイルシステムのルート一覧になる（`ifs-connection.ts:192` で `""` → `"/*"`）。
  `buildListFilesRequest` の空パスガードが働かない。`listFiles` 側で検証する
- **S6** 想定外の ReqRep ID のとき `error 0` という**D1 が「無意味」と記録したのと同じ symptom** が出る
  （`replyReturnCode` は非 `0x8001` で 0 を返すため）。ReqRep ID をメッセージに含める

### nit

- **N1** 範囲内だが奇数の LL（例 LL=7）は、宣言長を 1 バイト超えて読むのにエラーにならない。M1 と同根
- **N2** `ifs-types.ts:20` の「実機では 1 から連番」は**一般には誤り**。
  `/home` の実測では 6 → 1401 → 2157 → 3099 と飛んでいた（実装者の実行ログで確認）。弱い主張は弁護せず落とす
- **N3** `hasMore` / `canContinue` / `nextRestartId` の 3 つが連動しており、
  「どれを見ればいいのか」の迷いを生む。判別可能な直和型なら誤用を書けなくできる
- **N4** `parseListEntry` が裸のオフセット（30/34/50/54/77/81/91）と裸の `92` を使っている。
  92 対 93 の取り違えを説明したヘッダの 2 行下に、説明の無い `92` があるのは紛らわしい
- **N5** 21,192 件のディレクトリで `requestStream` が 21k 行のデバッグ出力を出す。
  `isDebugEnabled()` で守られてはいるが、ヘッダの既存の注意書きに一言添える価値がある

### 指摘なしと確認した観点

- **`replyReturnCode()` の誤用**（実装者が疑っていた点）: `makeDirectory` は rc を直接読んでおり、
  `listReplyKind` は rc を読む前に ReqRep ID を検査している。**成否を取り違える経路は無い**
- `parseListEntry` の他の境界（巨大 LL / LL<6 / 過大 templateLength / 短いフレーム）はすべて `As400Error`
- `frame.buffer` のエイリアシング: `byteOffset`/`byteLength` を正しく渡しており、
  トランスポートは複製を渡すので `onRawFrame` から読み取りバッファを壊せない
- `traced()` の素通し（D4）と `browser.ts` の型のみエクスポート（AGENTS.md の純粋性規約）
- `hasMore` を rc から導いていること（D1）と `.`/`..` の理屈

### 判定

**must が 5 件あるため coding へ差し戻す。**

特に M3 と M5 は、緑のテストと整合的なコメントが**実際には裏付けになっていなかった**類の欠陥で、
実装者が自分では気づけなかったもの。test-result.md の「688 通過」は `listFiles` については
見かけより弱い証拠である、という指摘も受け入れる。

## ラウンド 2（再レビューでの追加指摘）

前回の修正を同じレビュアに再確認してもらった。**must 2 / should 7**。
「直した」という主張ではなく、実際に直っているかを見てもらう趣旨。

### 前回分の確認結果（レビュア側で検証済み）

- M1・M3・M4・M5・S1〜S6 はいずれも**根本で直っている**ことを確認
- M3 の変異テストは、レビュア側の実測で **7 件が落ちる**（実装者の報告は 3 件で、申告より良かった）
- 新規テストの偽フレームが実機ダンプと一致することを機械的に照合済み
  （`parseListEntry` が読む全オフセットでバイト一致）

### must

**R1. M2 が半分しか適用されていない**
`listFiles` と `makeDirectory` は `fileFailure` に移したが、`open` / `writeFile` / `deleteFile` は
素の `PROTOCOL_ERROR` のままだった。`open` は read/write の入口なので、spec の 7 ルートのうち
`/read` `/write` `/download` `/zip` `/delete` の **5 つが依然 502**。
D7 の申し送りが「02 は `statusOf()` に 3 分岐を足せばよい」と読めるため、
02 は `/list` と `/mkdir` で動作確認して出荷し、`/read` が 502 のまま残る。

**R2. 誤って成功と判定する穴が `deleteFile` と `open` に残っていた**
`makeDirectory` では直したのに、5 行下の `deleteFile` が同じ誤りをしていた。
`open` はさらに悪く、rc=0 で素通りして**無関係なバイトをファイルハンドルとして使う**。

### should

R3（S2 にテストが無い）、R4（S2 は到着順に依存する。`fail()` で確定させるべき）、
R5（片付け経路のタイムアウトとの相互作用。ただし総合的には改善で、既存経路への影響は無いと確認済み）、
R6（**ディレクトリ判定の 2 条件が完全に未検証**。片方を消しても 707 件全緑）、
R7（`forTesting` の代替形）、R8（rc=1/32/33 が 502 のまま）、R9（not-found の判定が 2 箇所）。

### 対応と、対応中に発生した新たな欠陥

R1〜R9 すべてに対応（decisions D7〜D10）。ただし**修正が新たなバグを生んだ**:

R1/R2 の「3 箇所を共通の判定に揃える」対応で、**成功応答の ReqRep ID を確かめずに
どれも `0x8001` だと類推**したため、実機で書き込みが `unexpected reply 0x800b` で全滅した。
実際は WRITE が `0x800B`、OPEN が `0x8002`。実機検証で捕捉し、テストで固定した（D10）。

指摘が正しいことと、その直し方が正しいことは別だという実例。

### レビュアが検証・確認した論点

- **S2 は既存経路を壊さない**: `hostserver/` の全 `request()` 呼び出し元（signon / server-connect /
  command / db 各種 / netprint）を調査し、**すべて 1 要求 1 応答**であることを確認。
  IFS 以外に連鎖応答を使う経路は無い
- **M4 は必要な毒化まで消していない**: コールバック内 throw は真の途中失敗のみに限定され、
  そちらは今も接続を閉じる
- **rc=5 を ACCESS_DENIED に含めた判断は妥当**（`fileErrorText` が
  "Access denied to directory entry" と表示するため、13 と同じ扱いが自然）

### 判定

must 2 件・should 7 件すべて対応済み。R8 のみユーザー判断で **02-server-api へ送る**こととした。

