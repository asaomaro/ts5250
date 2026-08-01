# 決定記録

autonomous モードのため、人間ゲートを置かずに判断した事項を記録する。

## D1. research 工程は挟まない（requirement 終了時・2026-08-01）

protocol「4.5」の research 検知条件を評価した結果、**挟まない**と判断した。

| 検知条件 | 判定 | 根拠 |
|---|---|---|
| 調査で解消すべき未確定事項が残る | **No** | requirement 工程で依存グラフを全件実測した（hostserver 46 ファイルの外向き相対 import を集計し、外部依存が `errors` / `log` / `identifier` / `transport/host-connection` / `transport/ddm-transport` の 5 ファイルに限られることを確認）。残る未確定事項は**設計判断であって事実の欠落ではない** |
| 未検証の既存挙動に依存する | **No** | 後方互換を re-export で保つ方式は `20260726-library-extraction-codec`（PR #169）で実証済み。`@as400web/core` の `exports` に `.` / `./browser` / `./codec` があり、codec は既に外部パッケージへ転送されている |
| 技術的実現性の仮定がある | **No** | 同上。同じ monorepo で 2 パッケージの切り出しが完了しており、`tsc -b` の project references 構成も既存 |
| 変更が横断的 | **Yes** | 48 ファイル移動＋テスト 43 本＋core/server/web-ui/tools に波及 |

横断性は検知したが、これは**調査で減る性質のものではない**（事実は既に測れている）。
代わりに **spec の後に design 工程を挟む**方が適切と判断した——未確定事項の中心は
「共有層 `errors.ts` / `log.ts` / `identifier.ts` をどこに置くか」というアーキ判断であり、
protocol「4.5」の design 検知条件（複数コンポーネントにまたがる／アーキ判断が必要）に当たる。
採否は spec 終了時に再評価する。

## D2. `sql/split-statements.ts` を対象外にした（requirement 工程・2026-08-01）

backlog の項目 3 は対象を「`hostserver/` ＋ `hostserver/db/` ＋ `transport/host-connection.ts`」と
書いており `sql/` に言及していないが、ディレクトリ名から紛らわしいので実測して確認した。

- `packages/core/src/sql/split-statements.ts`（158 行）を参照しているのは
  `src/browser.ts` の re-export と `test/split-statements.test.ts` の 2 箇所のみ
- **hostserver 配下からの参照は 0 件**

SQL 文字列を文単位に割る web-ui 向けユーティリティであり、ホストサーバー通信の実装ではない。
本作業では動かさない。

## D3. `transport/ddm-transport.ts` を対象に追加した（requirement 工程・2026-08-01）

backlog は `transport/host-connection.ts` だけを挙げていたが、実測すると
`transport/ddm-transport.ts`（137 行）も利用者が hostserver 配下のみで、
かつ `host-connection.ts` の `HostTlsOptions` に依存している。

`transport/` は既に「hostserver 側（`host-connection` / `ddm-transport`）」と
「TN5250 側（`tcp` / `types`）」に割れており、前者だけを移すのが正しい切り目。
`ddm-transport.ts` を core に残すと、新パッケージから core への逆流依存が生まれる。

## D4. 共有層は複製できない（spec 工程・2026-08-01）

`errors.ts` / `log.ts` を core と hostserver に**複製する案は成立しない**ことを、
コードを読んで確認した。美観ではなく機械的な理由。

- `log.ts:43` が `let factory: LoggerFactory` を**モジュールスコープに持つ**。
  `setLogSink` はこれを書き換える。複製すると `packages/server` の `setLogSink` が
  片方にしか効かず、hostserver のログが黙って消える
- `errors.ts:131` の `As400Error` は `instanceof` で判定される。クラスが 2 つになると
  パッケージ跨ぎの `instanceof` が false になる。既存の
  `packages/core/test/errors-compat.test.ts` が `SqlError`（hostserver 側）で
  まさにこれを検査している

よって「core に残す（＝ hostserver が core に依存）」か「共有パッケージを作る」かの二択になり、
前者は切り出しの目的を損なうので `@as400web/base` を新設する。

## D5. パッケージ名を `@as400web/hostserver` にした（spec 工程・2026-08-01）

`@as400web/ibmi-client` 等の別案は**公開時の商品名の議論**であり、publish を対象外にした
本作業で先に決める理由がない。ディレクトリ名・既存の `tools/hostserver-check` と一致する
`hostserver` を採り、名前の再検討は publish を判断するときに行う
（`@as400web/ebcdic` も「公開するなら `@as400web/ccsid` も候補」と保留にしてある）。

## D6. `packages/server` の直参照化は follow-up（spec 工程・2026-08-01）

後方互換を `@as400web/core` の re-export で保つ以上、`core → hostserver` の依存が残り、
`@as400web/core` を import する側はホストサーバー一式も引き取り続ける。

これを解消するには `packages/server` の 37 ファイルを `@as400web/hostserver` 直参照へ移す必要があるが、
requirement で対象外にしている（PR を読める大きさに保つため）。**backlog に follow-up として起票する。**
本作業で改善されるのは「ホストサーバーだけ欲しい」側であり、backlog 項目 3 が求めていたのはこちら。

## D7. 既存のテスト失敗 4 件は環境要因（spec 工程・2026-08-01）

`packages/server/test/zip-writer.test.ts` の 4 件が `spawnSync unzip ENOENT` で落ちる。
この devcontainer に `unzip` コマンドが無いためで、**分割前から落ちている**。
本作業の合否は「この 4 件以外がすべて通ること」で判定し、緑に見せるための細工はしない。

## D8. design 工程は挟まない（spec 終了時・2026-08-01）

D1 で「spec の後に design を検討する」と保留していた件の結論。**挟まない。**

design を推奨する条件（protocol「4.5」: 複数コンポーネントにまたがる／アーキ判断が必要／
インターフェースが複雑／plan で分解するには粗い）のうち、前二者は該当していたが、
**spec 工程でそのアーキ判断そのものを決め切った**（D-A〜D-D、依存グラフ、移動一覧、
ガードテストの設計）。design.md を起こしても spec.md の写しにしかならない。

インターフェース設計も不要——**公開 API を一切変えない**のが本作業の要件であり、
新パッケージの export 面は既存の列挙をそのまま引き継ぐ。設計の自由度がある部分は
D-A（共有層の置き場所）だけで、そこは複製不能という制約から答えが 1 つに定まっている。

## D9. `socket-error-hint.test.ts` を base へ移した（coding 工程・2026-08-01）

`errors.ts` を移したあと、core の `socket-error-hint.test.ts` が
`@as400web/base` の `describeSocketError` / `withSocketHint` **だけ**を検査する形になっていた。
検査対象が別パッケージにあるテストを残すと、base 側を壊しても base のテストは緑のままになる。
base に移し、相対 import に戻した（base のテストが 0 件だった状態も解消される）。

`errors-compat.test.ts` と `log-sink-single-instance.test.ts` は **core に残す**——
こちらは「core のバレル経由でパッケージ跨ぎの同一性が保たれるか」を見ており、
core に置くこと自体に意味がある。

## D10. 一括置換で 2 度取りこぼした（coding 工程・2026-08-01）

`sed` による import 付け替えで、**同じ種類の見落としを 2 回**した。記録しておく。

1. **`from "…"` だけを対象にして動的 import を落とした。** `ddm-encode.test.ts` は
   `await import("../src/hostserver/ddm/ddm-connection.js")` と書いており、
   `from "…"` にマッチしないため 6 件が実行時に落ちた（型検査は通る）
2. **`sed` の区切り文字と正規表現の交替（`\|`）が衝突した。** `s|…|…|g` の中で
   `\(a\|b\)` と書いたため交替として解釈されず、深さ 1 のファイルだけ置換が漏れた

いずれも `tsc -b` とテストで捕まったが、**置換後に「残っていないこと」を必ず grep で確認する**
という手順にしていなければ黙って通っていた可能性がある。
新設した `no-core-dependency.test.ts` の指定子抽出は、この経験から
`from "…"` と `import("…")` の**両方**を拾うようにしてある。
