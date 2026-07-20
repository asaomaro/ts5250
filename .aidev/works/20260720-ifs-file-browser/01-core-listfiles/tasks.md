# タスク: 01-core-listfiles（プロトコル層 + 接続層）

- [x] T1: `packages/core/src/hostserver/ifs/ifs-types.ts` を新規作成し、`IfsEntry` / `IfsListResult` を定義する。
      `index.ts` と `browser.ts` の両方から再エクスポートする（web-ui は `core/browser` 経由でしか使えないため）。
      `browser.ts` の規約どおり `node:*` にも I/O にも触れないこと

- [x] T2: `ifs-datastream.ts` に `parseListEntry(frame): IfsEntry` を実装する（依存: T1）。
      offset 30 の 8 バイトから更新日時（UNIX 秒 + マイクロ秒 → ミリ秒）、**offset 50 の 4 バイト**から固定属性、
      offset 54 から種別、offset 77 から Restart ID、offset 81 の 8 バイトからサイズ、offset 91 から symlink、
      **`20 + 宣言 templateLength`** から名前の LL/CP を読む。
      ディレクトリ判定は種別（1=ファイル / 2=ディレクトリ）と固定属性の `0x10` ビットの**両方**を見る。
      テストは `research.md` F1-3 の実機 hex ダンプ（`hello.txt` 137 バイト / `subdir` 131 バイト）を固定データにする

- [x] T3: `ifs-datastream.ts` に `listReplyKind(frame): "entry" | "end" | "error"` を実装する（依存: T2）。
      `0x8005` は `entry`、`0x8001` かつ rc=18 は `end`、`0x8001` かつ rc=2/3 は「存在しない」、
      それ以外の rc は `error`。テストは実機ダンプの終端フレーム（24 バイト・rc=18）を使う

- [x] T4: `buildListFilesRequest` に `restartId` を足す。Restart ID は CP `0x000E` の 4 バイトを
      ファイル名の LL/CP の後ろに追加する形。全長の計算を忘れないこと。テストで配置を固定する

- [x] T5: `ifs-datastream.ts` に `buildCreateDirRequest(path)` を実装する。
      テンプレート長 8 / 要求 ID `0x000D` / 全長 `34 + name.length`。
      **ディレクトリ名の CP は `0x0001`**（ファイル名の `0x0002` ではない）。
      形が似ている `buildDeleteRequest` からのコピペで壊れるので、テストで CP を明示的に検証する

- [x] T6: spike で入れた `requestStream` を正式化する。連鎖の規約
      （終端まで読み切る／途中放棄したら接続を破棄する）をコメントで明文化し、テストを足す。
      テストでは**連鎖の残骸が次の要求の応答として読まれないこと**を確認する。
      `frame-trace.ts` の素通しにもテストを足す

- [x] T7: `IfsConnection.listFiles(path, opts)` を実装する（依存: T3, T4, T6）。
      パスに `*` が無ければ `/*` を付ける。`requestStream` で受け、**`0x8001` の受信で終端**とする
      （連鎖指示では判定しない）。`.` と `..` を除外する。`maxCount` 指定時に打ち切られたら `hasMore: true`。
      解析に例外が出たら `this.close()` してから再送出する

- [x] T8: `IfsConnection.makeDirectory(path)` を実装する（依存: T5）。
      応答は `0x8001` で返り、**rc=0 が成功**。rc=4（既存）は区別できるエラーにする。
      既存の `replyReturnCode` は「`0x8001` ならエラー」の前提なので、ここでは rc を直接見る

- [x] T9: `IfsConnection.rawConnection` を削除する（依存: T7, T8）。
      `tools/hostserver-check/src/ifs-list.ts` を `listFiles()` 経由に書き換える。
      生の hex ダンプ機能は残す（今後レイアウトを確かめるときに要るため、`--raw` などの形で）

- [x] T10: 実機で回帰を確認する（依存: T9）。
      `npm run ifs-list -w @as400web/hostserver-check -- --tls --path /home/USER/ifsdemo`
      で `hello.txt` / `nihongo.txt` / `subdir` / `link.txt` の 4 件が返り、`.` と `..` が
      含まれないこと、`subdir` がディレクトリ・`link.txt` が symlink と判定されることを確認する。
      `npm run ifs` の複数ブロック検証も再実行して壊れていないことを見る

- [x] T11: `npm test -w @as400web/core` が全て通ることを確認する（依存: T10）

- [x] T12: 【test からの差し戻し】Restart ID が進まないファイルシステムでの無限ループを塞ぐ。
      `/QSYS.LIB` は全エントリの Restart ID が 0 で返り、そのまま継続すると毎回先頭の数件が返る。
      `IfsListResult.canContinue` を足し、ID が 0 または渡した値から進んでいない場合は
      継続を提供しない。ユニットテストで判定を固定し、実機で `/QSYS.LIB`（止まる）と
      `/home`（264 件・14 ページで完走）の両方を確認する

- [x] T13: 【review からの差し戻し】must 5 件を修正する。
      M1 奇数長ファイル名の RangeError / M2 エラーコードを NOT_FOUND・ACCESS_DENIED・ALREADY_EXISTS に分離 /
      M3 listFiles を forTesting で単体テスト可能にし 18 件追加（変異テストで実効性を確認） /
      M4 終端フレームのエラーで接続を捨てない / M5 未使用エクスポート 9 個を削除し IfsListOptions を公開。
      should も併せて対応（S1 誤用を誘うコメント / S2 孤児フレームを desync 扱い / S3 単調増加 /
      S4 maxCount・restartId の範囲検証 / S5 空パス / S6 想定外 ID のメッセージ）
