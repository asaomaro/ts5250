# 決定記録

autonomous モードのため、人間ゲートを置かずに判断した事項を記録する。

## D1. backlog 3b の範囲を拡張した（requirement 工程・2026-08-01・ユーザー承認済み）

backlog の 3b は「`packages/server` の 37 ファイルを `@as400web/hostserver` 直参照へ移す」
だけだったが、**それでは 3b の目的（`core → hostserver` の辺を解消する）を達成できない**。
辺は core の `index.ts` が再輸出しているから存在するので、利用側を書き換えても core は
1 行も変わらない。

**前作業の報告で「3b と項目 4 の両方で『TN5250 だけ欲しい』が改善する」と書いたのは不正確**だった。
3b だけでは依存グラフは変わらず、得られるのは「依存の宣言が正しくなる」「読む人に出どころが
見える」までである。

範囲を「利用側の移設 ＋ 再輸出の撤去」に拡げることをユーザーに確認し、承認された。
**割らない理由**: 前者だけでは価値が出ず、後者だけでは利用側が壊れる。割ると中途半端な状態が残る。

## D2. `packages/web-ui` は対象外（requirement 工程・2026-08-01）

web-ui は `@as400web/core/browser` 経由で hostserver の型を 5 つ受けているが、
**直参照にしてはならない**。`@as400web/hostserver` は `node:net` / `node:tls` を含む Node 専用
パッケージで、ブラウザ向けパッケージの `dependencies` に載せるものではない。

`@as400web/core/browser` という入口はまさにそれを避けるために在る（`browser.ts` 冒頭コメント）。
型は実行時に消える——PR #233 で `packages/core/dist/browser.js` に `hostserver` の文字列が
**0 件**であることを実測済み。よって `browser.ts` の `export type` 3 箇所は残す。

これにより `core → hostserver` は**型のみの依存**として残るが、本作業の目的は
**実行時の辺**を消すことなので目的は達成される。

## D3. `ebcdic` / `scs` 由来の 6 件も一緒に移す（spec 工程・2026-08-01）

`LogicalPage`（scs）や `decodeCcsidText`（ebcdic）は hostserver とは別軸だが、
**同じ import 文の中に混ざっている**（`host-spools.ts` は 1 文で `As400Error` /
`ConnectOptions` / `LogicalPage` / `renderSpoolHtml` を取っている）。
どのみちその行を割るので、同じ作業で正しい宛先に振る。分けると同じファイルを 2 度触る。

## D4. `Tn5250Error` は改名しない（spec 工程・2026-08-01）

`tools/hostserver-check` の 7 ファイルが旧名を使っている。`@as400web/base` の JSDoc は
「新しいコードでは `As400Error` を使う」と書いているが、**これは新しいコードではない**。
本作業は import 元の付け替えに徹し、識別子には触れない——差分を
「どこから取るかだけが変わった」と読める状態に保つため。改名は別作業として review で記録する。

## D5. `packages/core` の `dependencies` から `@as400web/hostserver` は外さない（spec 工程・2026-08-01）

`browser.ts` が型で参照し続けるので、`dist/browser.d.ts` を型検査する利用者には解決が要る。
`devDependencies` へ移すと `browser` サブパスの型が解決できなくなる。

完全に外すには `browser.ts` の型 3 箇所を無くすしかなく、それは web-ui に
`@as400web/hostserver` を `devDependencies` として持たせ `import type` させることを意味する。
requirement で web-ui を対象外にしているので踏み込まない。**follow-up 3c として起票する。**

本作業の主目的は**実行時**の辺を消すこと。受け入れ基準は `dist/index.js` の
実行時 import が 33 → 0 になることで測る。

## D6. 撤去後のガードはビルド成果物を読む（spec 工程・2026-08-01）

`hostserver-reexport.test.ts` は「再輸出が到達可能なこと」を検査していたので、撤去で意味が反転する。
`hostserver-not-reexported.test.ts` へ `git mv` して中身を逆向きにする
（名前が意味と食い違ったまま残ると、次に読む人が中身と逆の期待をする）。

検査のうち 2 つは **`dist` を読む**——ソースの `export type` は目視で値と区別しにくく、
実行時に何が残るかは成果物を見るのが唯一確実。PR #233 で
「`dist/browser.js` に hostserver が 0 件」を実証したのと同じ見方。
**`dist` が無ければ落とす**（skip にすると「ビルドしていないから緑」という無意味な緑になる）。

## D7. 分類走査が見つけられない参照が 2 つあった（coding 工程・2026-08-01）

plan「4.」で「移し残しは分類走査で 0 にしてから撤去する」と決め、そのとおり
`packages/server/src` `test` `tools/hostserver-check/src` の残件を 0 にしてから撤去した。
にもかかわらず、**撤去後に 6 件のテストが落ちた**。走査が見ていたのは
「`import { … } from "@as400web/core"` の**名前**」だけで、次の 2 つはその形をしていなかった。

1. **`packages/core/test/log-sink-single-instance.test.ts`** —
   `insertRows` を `../src/index.js`（core のバレル）から取っていた。
   **走査の対象ディレクトリが `packages/server` と `tools` だけ**で、core 自身のテストを
   見ていなかった。→ `@as400web/hostserver` から取るよう修正
2. **`packages/server/test/host-spools.test.ts`** —
   `vi.spyOn(await import("@as400web/core"), "listSpooledFiles")` でモックしていた。
   **これは import 文ではない**ので走査に映らない。被験側（`host-spools.ts`）が
   `@as400web/hostserver` から取るようになったため、**モックしたつもりで実物が動く**状態になっていた
   （型エラーにもならない）。→ モック先を `@as400web/hostserver` に変更

**教訓**: 「バレル経由の参照」は import 文以外の形でも現れる。動的 import・`vi.mock` /
`vi.spyOn` の対象・文字列で指定するモジュール名は、名前ベースの走査では捕まらない。
前作業（`20260801-library-extraction-hostserver`）でも `await import("…")` を取りこぼしており、
**同じ穴を形を変えて 2 回踏んだ**ことになる。

新設した `packages/server/test/import-from-owner.test.ts` は import 文しか見ないので、
この穴は塞げていない。**塞げていないことを承知で残す**——`vi.spyOn` の対象まで静的に
追うのは過剰で、実際にはテストが落ちて気づけた（型検査では気づけなかったが、テストでは気づけた）。

## D8. core のテスト件数が 1 件減った（coding 工程・2026-08-01）

`hostserver-reexport.test.ts`（6 件）→ `hostserver-not-reexported.test.ts`（5 件）。
**カバレッジは落ちていない**——旧 6 件のうち「主要な入口が実際に使える形で取れている」は
hostserver 自身のテストが見ており、「package.json が hostserver に依存している」は
`browser.ts` の型検査が壊れることで tsc が捕まえる。
新 5 件は代わりに**ビルド成果物 2 つ**を検査しており、旧版には無かった強度がある。

全体では 3,263 → 3,265 件（+2）。内訳は
`import-from-owner.test.ts` +3 / guard の作り直し −1。

## D9. server のロガー 4 件を `./log.js` へ直した（review 工程・2026-08-01）

requirement は「振る舞いは一切変わらない（import 元の付け替えのみ）」としていたが、
**規約に明確に反する既存の欠陥**を見つけたため、この作業のうちに直した。

`db-pool.ts` / `host-sql.ts` / `result-set-store.ts` / `host-upload.ts` の 4 ファイルが、
サーバー自前の pino（`./log.js`）ではなく**ライブラリ側の注入式 `childLog`** を使っていた。
分割前は `@as400web/core` から取っていたため、注入式ロガーだと**気づきにくかった**。
import 元を実体に合わせた結果 `@as400web/base` と書かれることになり、露わになった。

AGENTS.md:「アプリ（server）は自前の pino を使う。消えて困る側を注入に依存させない」。
`main.ts` が `setLogSink` を呼ぶので通常の起動では出力されるが、それは注入に依存しているということで、
呼ばない入口（テスト・ツール・組み込み）では静かに消える。

**出力が減る変更ではない**（未注入の経路では増える）ので、報告だけして残すより直すのが正しい。
併せて `log-independence.test.ts` に走査を足し、再発を塞いだ。

## D10. `grep` を信じて 2 回取りこぼした（review 工程・2026-08-01）

- **1 回目**（coding）: 分類走査が import 文の名前しか見ず、`vi.spyOn(await import(…))` と
  core 自身のテストを落とした（D7）
- **2 回目**（review）: `grep -rn "childLog" … | grep import` が**複数行 import** の
  `db-pool.ts` を落とした。さらにこの環境の `grep` は当該ファイルに対して無出力を返し、
  存在するはずの行が「無い」ように見えた（`sed` で直読して初めて確認できた）

**いずれも Node で書いた走査（テスト）が正解を出し、シェルの grep が誤った。**
一次情報として grep の結果を報告する前に、走査で裏を取ること。
