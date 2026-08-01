# 決定記録

autonomous モードのため、人間ゲートを置かずに判断した事項を記録する。

## D1. `core` → `tn5250` の改名はユーザー判断（requirement 工程・2026-08-01）

項目 4 は「core から出す」のではなく「core そのもの」が対象で、出したあとに何が残るかで
形が決まる。3 案（core を絞る／改名する／新パッケージを作って core を残す）を提示し、
**改名**が選ばれた。

第 3 案（`@as400web/tn5250` を新設し core を残す）は、`html/` が `screen` / `protocol` に
依存するため **`core → tn5250` の辺が生まれる**——3b / 3c で消したばかりの形に逆戻りする。

## D2. `east-asian-width.ts` は `@as400web/base` へ（spec 工程・2026-08-01）

requirement を書く前の見立てでは「tn5250 に残す」だったが、**`spool-html.ts` が
これを import している**ことを実測して方針を変えた。`spool-html.ts` は `@as400web/scs` へ移すので、
`east-asian-width` は **tn5250 と scs の両方が要る**＝どちらにも置けない。

`@as400web/base` へ移す。これに伴い **base の役割が広がる**——現在の AGENTS.md は
「base に置くのは**複製すると壊れるもの**だけ」と書いているが、`east-asian-width` /
`csv-parse` / `split-statements` は純粋関数で、複製しても壊れはしない（ただ重複するだけ）。

**第 2 の基準を明記する**: 「複数のパッケージが要るが、どれにも属さないもの」。
`identifier.ts` を base に置いた時点で実質この基準を使っていた（あれも
「hostserver と web-ui の両方が使い、どちらにも属さない」が理由だった）。
基準が 2 つあることを AGENTS.md に書き、**物置にしないための歯止め**として
「片方しか使わないものは使う側に置く」も併記する。

**別パッケージを立てる案は退けた**——395 行のために 6 つ目のパッケージを作ると、
利用側の `dependencies` が 1 つ増えるだけで、境界の説明はむしろ難しくなる
（「テキスト処理」は TN5250 でもホストサーバーでもない、という消去法の定義しかできない）。

## D3. `@as400web/core/codec` ファサードは廃止する（requirement 工程・2026-08-01）

`packages/core/src/codec/codec.ts`（34 行）は `@as400web/ebcdic/codec` への転送のみ。
実利用者は `packages/server/src/host-dtaq.ts` の 1 箇所だけで、3b で確立した
「使うものは在り処から取る」に従えば `@as400web/ebcdic/codec` を直接使うべきもの。

改名（`@as400web/core/codec` → `@as400web/tn5250/codec`）でどのみち利用側を触るので、
**転送先へ向け直すのと同じ手間**で廃止できる。「TN5250 パッケージが EBCDIC の入口を
持っている」状態自体が、名が体を表さない例でもある。

## D4. `tn5250 → scs` は正当な辺（coding 工程・2026-08-01）

spec に「tn5250 の `dependencies` は base / ebcdic の 2 つだけ」と書いたが**誤りだった**。
`session/printer-session.ts` が `ScsDecoder` を使う——**5250 のプリンターセッションは
ホストから SCS を受け取って復号する**ので、TN5250 の一部として正しい依存である。

実際の依存は **base / ebcdic / scs の 3 つ**。受け入れ基準も直した。

一方で `index.ts` の `export { ScsDecoder, type LogicalPage } from "@as400web/scs";` は
**利用者が 0 件**だった（server は 3b で `@as400web/scs` 直参照へ移していた）ので削除した。
「使うものは在り処から取る」に従い、tn5250 が SCS の入口を兼ねる必要はない。

## D5. バンドルが 4 倍に膨らんだ（coding 工程・2026-08-01）

`spool-html` を `@as400web/scs` へ移し、web-ui が `@as400web/scs`（**バレル**）から
`renderSpoolHtml` を取るようにしたところ、**バンドルが 359,853 → 1,458,480 バイト**になった。

バレル経由で `ScsDecoder` → `scs.ts` → `@as400web/ebcdic`（バレル）→ **変換表 5 つ**に
到達していた。`20260726-ccsid-table-bundling` が塞いだのと同じ失敗様式で、
AGENTS.md にも「バレル経由だと bundler の解析が及ばず要らない部分が残る」と書いてある。

**`@as400web/scs/spool-html` の狭い入口を新設**して解決した（`ebcdic` の
`./codec` / `./katakana` / `./catalog` と同じ手）。`spool-html.ts` が `scs.ts` から取るのは
`LogicalPage`（**型のみ**）なので、実行時依存はもともと無い。

**受け入れ基準にバンドルサイズを入れていなければ、ビルドもテストも通るまま
4 倍のバンドルを出荷していた。**

## D6. lockfile は再生成せず手当てした（coding 工程・2026-08-01）

`packages/core` → `packages/tn5250` の改名で `package-lock.json` に
`extraneous` な `packages/core` が残った。`rm package-lock.json && npm install` で
再生成すると解消したが、**`resolved` 374 行・`integrity` 373 行が消えた**
（サプライチェーン検証が弱くなり、インストールの再現性も落ちる）。

再生成をやめ、**キーの改名だけを行ってから `npm install` で整合させた**——
差分は 19 行の追加・18 行の削除に収まり、`resolved` は 412 件すべて残っている。

## D7. `@as400web/core/codec` の廃止で 4 件のテストが消えた（coding 工程・2026-08-01）

`codec-reexport.test.ts` の 8 件のうち 4 件がファサード（`/codec` サブパス・`ScsDecoder` 再輸出）
そのものを検査していたので、対象が消えるとともに削除した。**カバレッジの喪失ではない**——
検査対象が無くなったのであって、残る 4 件が ebcdic の再輸出を引き続き見ている。

## D8. `@as400web/tn5250` の ebcdic 再輸出は残す（coding 工程・2026-08-01）

`index.ts` は今も `SbcsCodec` / `codecForCcsid` / `decodeCcsidText` 等を
`@as400web/ebcdic` から再輸出している。実測すると**外部の利用者はほぼ居ない**
（server / tools は既に `@as400web/ebcdic` 直参照。web-ui の `IfsPane.vue` だけが
`@as400web/tn5250/browser` 経由で `TEXT_CCSIDS` を取るが、これは
**表を引き込まない狭い入口**を維持するための意図的な経路）。

撤去は item 4 のスコープ外なので触らない。**follow-up として backlog に起票する。**
