---
backlog: library-extraction
kind: topic
---

# ライブラリ切り出し

`packages/core` の各層を他プロジェクトから使えるライブラリとして切り出す構想。
2026-07-18 の ACS データ転送（signon 認証）実装時に、結合度を測って洗い出した。

## 前提: 依存関係の実測（2026-07-18 時点）

```
codec      227行 ＋ テーブル18,900行   依存: なし        ★完全に独立
scs.ts     246行                       依存: codec のみ
hostserver 878行                       依存: errors/codec/log/transport
protocol ⇄ screen                      相互依存（分割不可）
session    770行                       依存: ほぼ全部 ＝ TN5250 クライアント本体
```

## 先に返すべき負債（どの切り出しにも共通で効く）

切り出しの実作業より、こちらが本体。**とくにコーデックは「依存ゼロ」が売りなので、
pino を持ち込むと価値が半減する。**

- [x] ロガーを注入可能にする（現在 `pino` を直接依存。ライブラリが利用側にロガーを強制している）
  - `hostserver/` は `log.ts` を1箇所で使うだけなので、今なら数行で済む
  - **2026-07-19 完了**（`.aidev/works/20260719-core-debt-payoff`）。
    core は `setLogSink` で注入する形にし、**既定は no-op**。`pino` は core から server へ移した。
    実測: pino の import は `log.ts` の 1 箇所だけだったが、**server の 6 ファイルが core の
    `childLog` に乗っていた**。素直に no-op 化すると `audit.ts` の監査証跡が静かに消えるため、
    **依存の向きを逆にして server に自前の pino を持たせた**（消えて困る側を注入に依存させない）
- [x] 例外の基底を `Tn5250Error` → `As400Error` に改名（旧名は別名で維持し既存コードを壊さない）
  - ホストサーバーは TN5250 ではないのに `Tn5250Error` を投げていて、名が体を表していない
  - **2026-07-19 完了**。出現は全 298 行（core 214 / server 78 / tools 6 / **web-ui 0**）。
    作業中に `index.ts` の re-export まで一括置換してしまい**旧名が外へ出なくなった**（＝後方互換が
    壊れた）ので、`instanceof` を含む互換テストを追加して型で守るようにした
- [x] ~~`ErrorCode` の整理（19種に … ホストサーバーに無縁のものが混在）~~
      **← この記述は実測と食い違っていた（2026-07-19 に確認）**
  - 実際は **21 種で、未使用のコードは 0 件**。「無縁のものを消す」作業は存在しない
  - 実在する問題は別物: **`CONNECT_FAILED` の意味が壊れている**——server 側で
    「限度到達」「参照不正」「users ファイルが読めない」など**接続と無関係な用途に 11 箇所**流用されている。
    偏りも大きい（`PROTOCOL_ERROR` 65 / `CONFIG_ERROR` 33 / `CONNECT_FAILED` 22 で全体の約 41%）
  - やるなら「core の型を整理する」ではなく「**server の 11 箇所の意味を決め直す**」作業。
    HTTP ステータス写像（`host-api.ts`）にも波及するので、独立した作業として起こすこと
  - **2026-07-29 に完了**（`20260729-connect-failed-semantics`）。実測は **12 箇所**（11 ではなかった）。
    内訳と移し先:
    - **セッション上限 2 箇所 → `SESSION_LIMIT`（新設）／HTTP 400 → 409。**
      「繋ぎに行く前に自分側で断っている」ので接続の失敗ではない。409 は既にある
      「時間や対象を変えれば通りうる」の棚（`ALREADY_EXISTS`/`RESOURCE_BUSY`/`NOT_EMPTY`）と同じ扱い。
      `RESOURCE_BUSY` の流用は退けた——あちらは**ホスト上の対象**が掴まれている状態で、
      UI が「他の処理が対象を使用中です」と案内するため嘘になる
    - **設定・指定の不備 10 箇所 → `CONFIG_ERROR`。** `statusOf` は両方 400 なので
      **HTTP の後方互換は保たれた**（設定ファイルが読めない・スキーマ違反・平文パスワード・
      `passwordEnv` 未設定・資格情報が無い・接続先の指定不足）
    - **偏りの是正はしていない。** 件数を平すのは目的ではなく、意味が合っているかだけを見た
  - **腐りの原因も塞いだ**（ここが本体）:
    - `ErrorCode` の**前半 16 種にコメントが無かった**（実測 25 種。上の「21 種」は 2026-07-19 時点の数で
      その後増えていた）。意味が書かれていないコードには呼び出し側が「近そうなもの」を選ぶ。
      **全 26 種に用途と使い分けの JSDoc を書いた**
    - `ws-handler.ts` の `fatal` 判定が**エラーコードの列挙**だった。コード名を変えた瞬間に
      意味が黙って変わる形（実際この作業で「開けなかった」が致命的でなくなるところだった）。
      **状態（`this.sessionId === undefined`）で決める**ようにした
    - `packages/server/src` 全体を走査して「**`CONNECT_FAILED` を throw する箇所が 0 件**」を
      不変条件テストにした（列挙にすると新しいファイルが素通りする）
- [x] CCSID テーブルの同梱単位を見直す（CCSID 37 の174行のために DBCS 込み18,900行が付いてくる）
  - **2026-07-27 完了**（`.aidev/works/20260726-ccsid-table-bundling` / PR #171）。
    web-ui の本番バンドルは **1,407,469 → 358,354 バイト**（2026-08-01 に再測）。
    残る表の識別子は `ibm-930_P120-1999_SBCS` / `ibm-939_P120-1999_SBCS` の **2 つだけ**で、
    DBCS 部・`ibm-1399`・`ibm-37`・`ibm-273` は 0 件
  - 採った手は **(b)＋(c)**——SBCS 部を別モジュールへ切り出し、`@as400web/ebcdic/katakana` の
    サブパスを新設した。web-ui は `@as400web/core/browser` から
    **`katakanaChar` / `latinChar` の 2 関数**を取る（`ScreenGrid.vue:66-67`）
  - **SBCS 部が 2 つ残るのは正しい**。2 関数が 1 対 1 で表に対応している——
    `katakanaChar`＝930 の SBCS 部（CP290）／`latinChar`＝939 の SBCS 部（CP1027）。
    2 つは互いの鏡像で、表示コード切替とは「もう一方の表で読み直すこと」だから両方要る。
    930 の表しか持たないと 930 のセッションで切替が無反応になる（利用者報告で判明。
    `packages/ebcdic/src/katakana.ts` の JSDoc に経緯）
  - 再混入は `packages/ebcdic/test/katakana-no-dbcs.test.ts` が塞いでいる——src の import グラフを
    実際に辿り、到達可能なファイルを 4 つに固定する（対照として `codec.ts` からは DBCS 部に
    到達することも検査しており、ガードが効いていることを保証している）
  - **2026-07-19 に原因を実測**~~（作業自体は未着手）~~。テーブルは計 **18,900 行 / 1.17 MB**
    （dist の js で 1,372 KB。ibm1399 が 557 KB、930/939 が各 298 KB）
  - tree-shaking が効かない具体的な原因:
    - `codec.ts:2-6` が 5 テーブルすべてを**静的な値 import**（`import type` ではない）
    - `codec.ts:161-173` がトップレベルで `new Map([...])` に全テーブルを詰めている
    - **`codec.ts:179-180` の `katakanaChar()` が `ibm930` を直接参照**。web-ui が
      `@as400web/core/codec` から import しているのは**この 1 関数だけ**なのに、
      これ経由で全 5 テーブルが到達可能になる
    - `pure-dbcs.ts:10` が独立に `ibm1399` を静的 import
    - 生成物は `tools/gen-tables` が **`.ts` として src に直接書き出し**ており、遅延ロードできる形式ではない
  - 直すには (a) 遅延 import 化 / (b) サブパス export の分割 / (c) 生成物の形式変更 のいずれかが要り、
    **ブラウザのバンドル方法に影響する**。バンドルサイズを実測しながら進める独立作業にすること
  - **2026-07-27 追記**（`20260726-library-extraction-codec`）: 表は `@as400web/ebcdic` へ移り、
    (b) の足場として **`./codec`（変換のみ）と `./catalog`（表ゼロ）のサブパスが既にある**。
    ~~実測した現状: web-ui の本番バンドルは **1,407,469 バイト**で、うち ibm-930/939 の表が占める。
    到達経路は **`ScreenGrid.vue:41` の `katakanaChar` 1 関数だけ**
    （`@as400web/core/codec` → `@as400web/ebcdic/codec` → 表 5 つ）~~
    **← 着手前の状態。現在は 358,354 バイトで、`ScreenGrid.vue` は
    `@as400web/core/browser` から取る（web-ui に `@as400web/core/codec` の import は 0 件）**。
    つまり「`katakanaChar` を表非依存にする」か「カタカナ SBCS だけの入口を足す」かで大半が落ちる見込み。
    比較の基準線として、`main` を worktree に取って同一条件でビルドし突き合わせる手順が有効だった

> **未適用だった注意（解消済み）**: 「ロガー注入」「`no-restricted-globals`」は
> `20260718-acs-data-transfer` と `20260718-hostserver-sql` の retro で**2 回とも提案されたが未適用**だった。
> **2026-07-19 に両方とも適用した**（`20260719-core-debt-payoff`）。
> `no-restricted-globals` は追加したうえで、違反コードを実際に書いて lint が落ちることを確認している。
> **UI の落とし穴（2026-07-20）**: `docs/UI-DESIGN.md` に**二重スクロール**の注意が無い。
> `SqlPane` で、ペイン自体が `overflow:auto` のところに表領域へ `max-height` を付けたら
> 列見出しが画面外へ押し出された。**ペインは縦フレックスにし、スクロールさせるのは
> 内側の 1 箇所だけ**にする、という指針を UI-DESIGN に足すとよい。
> 自動テストでは気づけず、スクリーンショットで初めて分かった。
>
> **新たに見つかった穴**: `eslint.config.js:12` が **`packages/web-ui/**` を丸ごと無視**している。
> web-ui にはリントが一切かかっていない（`no-console` も型の未使用も検出されない）。
> 有効化すると既存コードが大量に落ちる可能性があるので、件数を測ってから別作業で扱うこと。
>
> なお retro の列挙にあった `setTimeout` は**禁止しなかった**——ブラウザにも標準の Web API で
> Node 固有ではなく、`session/` のネゴシエーションのタイムアウトという正当な用途で使われているため。

## 切り出し候補（推奨順）

- [x] **1. EBCDIC コーデック** — 依存ゼロ、今すぐ出せる、独自価値が明確
  - SBCS(37/273) と DBCS(930/939/1399)、SO/SI 制御に対応。npm の EBCDIC 系は SBCS 止まりが多い
  - ICU の .ucm から生成する `tools/gen-tables` も併せて出せば CCSID を増やせる
  - **2026-07-27 に monorepo 内の分割まで完了**（`20260726-library-extraction-codec` / PR #169）。
    `@as400web/ebcdic` として独立。`dependencies` は空、入口は `.` / `./codec`（変換のみ）/
    `./catalog`（表ゼロ・ブラウザ用）の 3 つ。`tools/gen-tables` の出力先も付け替え済み
  - **publish は未実施**（今回のゴールは「公開の判断を後回しにできる状態にすること」）。
    公開するなら README とパッケージ名の再検討が要る——`ccsid-text.ts` が非 EBCDIC
    （UTF-8 / ISO-8859-1 / Shift_JIS）も扱うため `@as400web/ccsid` も候補だった
- [x] **2. SCS デコーダ** — 246行、依存は codec のみ。1 と同じ切り出しで一緒に出せる
  - スプールのバイト列 → 論理ページ。`server/src/pdf.ts` が66行で済んでいるのは分離が効いている証拠
  - IBM i のスプールを扱いたいが TN5250 一式は要らない、という需要に合う
  - **2026-07-27 に完了**（同上）。`@as400web/scs` として独立し、依存は `@as400web/ebcdic` のみ。
    **1 とは別パッケージにした**——「一緒に出せる」は*同時に出す*であって*1 つにまとめる*ではないと解した。
    サブパスで分けても npm の依存グラフ上は 1 つのままで、EBCDIC だけ欲しい利用者に
    印刷ストリームのデコーダが付いてくる（`20260726-library-extraction-codec/spec.md` D1）
  - `tsconfig` の `types` を空にできた（`TextDecoder` を使わないため）＝Node API を型検査で塞げている
- [x] 3. ホストサーバー（`hostserver/` ＋ `hostserver/db/` ＋ `transport/host-connection.ts`）
  - **前提を満たした**（2026-07-18 に SQL 実行が完了。`20260718-hostserver-sql`）。
    「IBM i に SQL を投げる TS ライブラリ」として単体で価値が出る状態になった
  - ~~規模: 認証 878 行 ＋ SQL 約 1,200 行。純 DBCS コーデックも併せて要る~~
    **← 2026-07-18 時点の値。その後 IFS・DDM・DTAQ・スプール・各種一覧が載って大きく増えた**
  - ~~ただし**アップロードが載ってから**のほうが切り出しの価値は高い（API が固まる）~~
    **← 満たされた**（`20260719-hostserver-upload-ddm` で DDM 経由のアップロードが着地）
  - **2026-08-01 完了**（`.aidev/works/20260801-library-extraction-hostserver`）。
    `@as400web/hostserver` として独立。実測 **48 ファイル / 10,743 行**
    （`hostserver/` 46 ファイル 10,290 行 ＋ `transport/host-connection.ts` 316 行
    ＋ `transport/ddm-transport.ts` 137 行）。`dependencies` は base / ebcdic / scs の 3 つだけ
  - **`transport/ddm-transport.ts` も対象に足した**——この backlog は `host-connection.ts` しか
    挙げていなかったが、実測すると利用者は hostserver 配下のみで `HostTlsOptions` に依存しており、
    core に残すと逆流依存になる。`transport/` は既に「hostserver 側」と
    「TN5250 側（`tcp.ts` / `types.ts`）」に割れていた
  - **切り出し面は薄かった**。hostserver 46 ファイルが外へ張る相対 import は全件集計で
    **5 ファイルだけ**（`errors.ts` 28 / `log.ts` 10 / `transport/host-connection.ts` 10 /
    `transport/ddm-transport.ts` 1 / `identifier.ts` 2）
  - **本題は共有層で、`@as400web/base`（291 行・依存ゼロ）を新設した**。
    `errors.ts` / `log.ts` / `identifier.ts` は**複製すると壊れる**——`log.ts` は
    モジュールスコープの可変状態（`setLogSink` が書き換える）を持ち、実体が 2 つだと
    注入が片方にしか効かずログが黙って消える。`As400Error` は `instanceof` で判定されるので
    クラスが 2 つだとパッケージ跨ぎの判定が false になる。**どちらも `tsc -b` は通る**
    （複製した状態で実際に確認した）ため、実行時テストで固定した
    （`core/test/log-sink-single-instance.test.ts` / `errors-compat.test.ts`）
  - **利用側は 1 行も変えていない**——`packages/server` 37 ファイル・`packages/web-ui` 22 ファイル・
    `tools/hostserver-check` の追跡ファイル差分は 0。後方互換は `@as400web/core` からの
    列挙 re-export で保ち、到達可能性をテストが検査する
    （**`@as400web/hostserver` 自身の公開面と突き合わせる**ので、行ごと消しても捕まる）。
    ~~`core/test/hostserver-reexport.test.ts`~~ **← 3b で再輸出ごと撤去したため
    `core/test/hostserver-not-reexported.test.ts`（逆向きの検査）に作り直した**
  - **実測値（次に測る人の基準線）**: web-ui 本番バンドル **359,853 バイト（前後で完全一致）**、
    テスト **3,248 → 3,263 件**（+15 はすべて新設ガード。1 件も減っていない）。
    既知の失敗は `zip-writer.test.ts` の 4 件のみで、`unzip` 未インストールによる環境要因（分割前から）
  - **eslint のピュアロジック層ガードが消えかけた**。移設前 `hostserver/**` は
    `packages/core/src/**` の glob 下で `node:*` 禁止が効いていた（実測で import 0 件）。
    `eslint.config.js` の `files` に base / hostserver を足さなければ**保護だけが黙って消えていた**
  - **publish は未実施**（項目 1・2 と同じく「公開の判断を後回しにできる状態」までがゴール）
- [x] 3b. 利用側を直参照へ移し、`@as400web/core` の hostserver 再輸出を撤去する
  - 項目 3 の follow-up（`20260801-library-extraction-hostserver` decisions.md D6）。
    後方互換を `@as400web/core` の re-export で保った結果、**`core → hostserver` の辺が残っている**
    ——`@as400web/core` を import する側はホストサーバー一式も引き取り続ける
  - ~~項目 3 で改善されたのは「ホストサーバーだけ欲しい」側。「TN5250 だけ欲しい」側は
    **項目 4 と、この 3b の両方**が要る~~
    **← 起票時の記述が不正確だった。** 「`packages/server` の import を移す」だけでは
    **辺は消えない**——再輸出しているのは core の `index.ts` なので、利用側を書き換えても
    core は 1 行も変わらない。**再輸出の撤去まで含めて初めて**目的が達成される
  - ~~移した後も `@as400web/core` の re-export は外部利用者のために残す（`codec` と同じ扱い）。
    `core/test/hostserver-reexport.test.ts` があるので、消すと落ちる~~
    **← 撤去した。** publish していない以上「外部利用者」は仮想で、実在の利用者
    （server / tools / web-ui）は全部 monorepo 内。残す理由が無い
  - **2026-08-01 完了**（`.aidev/works/20260801-library-extraction-drop-core-reexport`）。
    ユーザー判断で範囲を「利用側の移設 ＋ 再輸出の撤去」に拡張した——前者だけでは価値が出ず、
    後者だけでは利用側が壊れるので、割ると中途半端な状態が残る
  - **実測値（次に測る人の基準線）**: `packages/core/dist/index.js` の
    `@as400web/hostserver` が **33 → 0 箇所**（＝実行時の辺が消えた）。
    web-ui 本番バンドルは **359,853 バイトで前後一致**、テストは **3,263 → 3,266 件**（失敗 0）
  - 移設は **58 ファイル / 61 import 文**（`packages/server/src` 31・`packages/server/test` 16・
    `tools/hostserver-check/src` 11）。宛先は base 46 / hostserver 37 / core 15 / scs 3 / ebcdic 3 文
  - **`browser.ts` の型のみ再輸出 3 箇所は意図的に残した**。`@as400web/hostserver` は
    `node:net` を含む Node 専用パッケージで、ブラウザ向けパッケージの依存に載せるものではない。
    型は実行時に消えるので `dist/browser.js` には現れない（0 件を検査している）
  - **既存バグを 1 件見つけて直した**——`db-pool.ts` / `host-sql.ts` / `result-set-store.ts` /
    `host-upload.ts` の 4 ファイルが、サーバー自前の pino ではなく**ライブラリ側の注入式
    `childLog`** を使っていた。分割前は `@as400web/core` 経由だったので気づきにくかった。
    `log-independence.test.ts` に走査を足して塞いだ（足した直後に 4 件目を検出した）
  - 不変条件は `core/test/hostserver-not-reexported.test.ts`（**ビルド成果物を読む**）と
    `server/test/import-from-owner.test.ts`（走査）で固定。**再輸出を 1 行戻したとき
    `tsc -b` は通った**——型検査では捕まらない
- [x] 3c. `packages/core` の `dependencies` から `@as400web/hostserver` を完全に外す
  - 3b の follow-up（`20260801-library-extraction-drop-core-reexport` decisions.md D5）。
    実行時の辺は消えたが、**型のみの依存が残っていた**——`browser.ts` が
    `UploadRejection` / `IfsEntry` / `IfsListResult` / dtaq 型群を `export type` していた
  - **2026-08-01 完了**（`.aidev/works/20260801-library-extraction-cleanup`）。
    予想どおり web-ui が `@as400web/hostserver` を `devDependencies` に持ち
    `import type` する形にした。`packages/core` の `dependencies` は
    **base / ebcdic / scs の 3 つだけ**になり、`tsconfig.json` の `references` からも外れた
  - **触ったのは web-ui の 4 ファイルだけ**（`ifsApi.ts` / `dtaqApi.ts` /
    `components/TransferPane.vue` / `test/use-ifs-tree.test.ts`）。
    `useIfsTree.ts` / `IfsPane.vue` / `DtaqPane.vue` はローカルモジュール経由で型を得ており、
    `@as400web/core/browser` を直接見ていなかった
  - **`DtaqEntry` / `DtaqType` は移さず消した**——`browser.ts` が再輸出していたが
    **web-ui での利用は実測 0 件**だった
  - **実測値（次に測る人の基準線）**: web-ui 本番バンドル **359,853 バイトで前後一致**、
    バンドル内の `node:net` / `node:tls` / `hostserver` の文字列とも **0 件**
    （`import type` が実行時に消えていることの三重の裏取り）
  - **ガードは宣言まで見る**（`core/test/hostserver-not-reexported.test.ts`）。
    ソースの参照が 0 でも `package.json` に残っていれば「実行時に引かないだけで依存はしている」
    状態に戻れるため。`browser.ts` の例外も消して「`src` に 0 件」に強化した
  - **落とし穴**: root の `npm run build`（`tsc -b`）は **web-ui を検査していない**。
    web-ui は project references に入っておらず、しかも `tsconfig.test.json` で
    **test も型検査の対象**。root が緑のまま `web-ui/test/` が落ちた（AGENTS.md に反映済み）
- [x] 3d. 旧名 `Tn5250Error` を新しいコードから消す
  - ~~`tools/hostserver-check` の 7 ファイルが旧名を使っている~~
    **← 起票時の見積もりが狭かった。** 実測すると **32 ファイル / 78 箇所**
    （`packages/hostserver/test` 20・`tools/hostserver-check/src` 8・`packages/core/test` 4）。
    tools だけ直しても約 55 箇所が残り、「新旧の混在を意図していない」という目的が達成されない
  - **2026-08-01 完了**（同上）。使われ方は `import` と
    `expect(() => …).toThrow(Tn5250Error)` の 2 種類だけで、**同一クラスなので振る舞いは変わらない**
  - **残した 5 ファイル（意図的）**: `base/src/errors.ts`・`base/src/index.ts`（別名の定義そのもの。
    外部利用者のための互換シム）／`core/src/index.ts`（公開 API の後方互換）／
    `core/test/errors-compat.test.ts`（**新旧の同一性を検査するのが役目**。消すと検査が成立しない）／
    `core/test/codec-reexport.test.ts`（改名の経緯を述べたコメント）
  - `errors-compat.test.ts` が緑＝**旧名は引き続き `@as400web/base` と `@as400web/core` から取れる**
- [x] 4. TN5250 クライアント一式（`protocol`/`screen`/`session`/`telnet`/`transport`/`trace`）
  - `protocol ⇄ screen` が相互依存のため分割不可。出すなら一式 ← **実測でも確認**（7 と 4 の相互 import）
  - 競合あり（例: green-screen-react）。差別化軸は「純 TypeScript・依存なし・トレース再生付き」
  - ~~最も重いので最後でよい~~ **← 行数は最大（5,044 行）だが、外へ張る依存は
    `session → util/emitter.ts` の 1 本だけで、切り出し自体は最も素直だった**
  - **2026-08-01 完了**（`.aidev/works/20260801-library-extraction-tn5250`）。
    **前 3 回と違い「core から出す」のではなく「core そのもの」が対象**だったため、
    ユーザー判断で **`@as400web/core` → `@as400web/tn5250` の改名**という形を採った
    （6 ディレクトリだけ出すと、残った core が新パッケージに依存し返す＝3b/3c で消した形に逆戻り）
  - **「core」という名前が問題の一部だった**——何が入っているのか名前が語らないので、
    実際に TN5250・ホストサーバー・EBCDIC・SCS・CSV 解析・SQL 文分割が同居していた。
    名が体を表せば、足すときに「これは tn5250 か？」と問える
  - **中身の整理**: `csv-parse`(128) / `split-statements`(158) / `east-asian-width`(109) →
    `@as400web/base`、`spool-html`(217) → `@as400web/scs`、
    `util/emitter` → `session/` 配下、`html/screen-html` → `src/` 直下。
    **`@as400web/core/codec` ファサード（34 行）は廃止**（利用者 1 箇所を `@as400web/ebcdic/codec` 直参照へ）
  - **`tn5250 → scs` は正当な辺**——プリンターセッションがホストから SCS を受け取って復号する
  - **実測値（次に測る人の基準線）**: 追跡ファイルの `@as400web/core` **0 件**、
    テスト **3,268 → 3,269 件**（失敗 0）、web-ui 本番バンドル **359,853 → 359,857 バイト**
  - **途中でバンドルが 4 倍（1,458,480 バイト）に膨らんだ**。`spool-html` を scs へ移し、
    web-ui が **scs のバレル**から取るようにしたところ `ScsDecoder` → `@as400web/ebcdic`（バレル）
    → 変換表 5 つに到達した。`20260726-ccsid-table-bundling` と同じ失敗様式で、
    **狭い入口 `@as400web/scs/spool-html` を新設**して解決。
    受け入れ基準にバンドルサイズを入れていなければ気づかず出荷していた
  - **依存の向きを 1 か所で宣言する走査ガードを新設**（`tn5250/test/dependency-direction.test.ts`）。
    従来は辺ごとに個別テストを書いており、5 パッケージ＝15 通りでは書き忘れが素通りする。
    **このガード自体が 1 回目は効いていなかった**——正規表現 `@as400web/[a-z-]+` が数字を含まず、
    `tn5250` を `tn` と拾っていた（わざと壊す検証で発覚）
  - **`@as400web/base` の役割を 2 基準で明文化**（AGENTS.md）。「複製すると壊れるもの」に加えて
    「複数のパッケージが要るが、どれにも属さないもの」。**物置にしないための歯止め**
    （片方しか使わないものは使う側に置く）も併記——core が袋になったのと同じことを base で起こさないため
  - **publish は未実施**（項目 1〜3 と同じく「公開の判断を後回しにできる状態」までがゴール）
- [x] 4b. `@as400web/tn5250` の ebcdic 再輸出を撤去する
  - 項目 4 の follow-up（`20260801-library-extraction-tn5250` decisions.md D8）。
    `index.ts` が `SbcsCodec` / `codecForCcsid` / `decodeCcsidText` 等を
    `@as400web/ebcdic` から再輸出しているが、**外部の利用者はほぼ居ない**
    （server / tools は既に `@as400web/ebcdic` 直参照）
  - 唯一残るのは web-ui の `IfsPane.vue` が `@as400web/tn5250/browser` 経由で
    `TEXT_CCSIDS` / `ccsidLabel` を取る経路。ただしこれは**表を引き込まない狭い入口**
    （`@as400web/ebcdic/catalog`）を維持するための意図的な中継なので、
    **撤去するなら web-ui を直参照へ移すのとセット**
  - ~~優先度は低い（実害は「出どころが見えにくい」だけ）~~
    **← 実害はもう 1 つあった。再輸出は「`@as400web/tn5250` を何でも入っている袋に戻す入口」**
  - **2026-08-01 完了**（`.aidev/works/20260801-library-extraction-drop-ebcdic-reexport`）。
    実測すると再輸出は **24 名前あって、使われていたのは 6 個だけ**だった（残り 18 個は死んだ再輸出）
  - 利用者はすべて web-ui。**狭い入口へ付け替えた**——`TEXT_CCSIDS` / `ccsidLabel` / `LineEnding`
    → `@as400web/ebcdic/catalog`（表ゼロ）、`katakanaChar` / `latinChar`
    → `@as400web/ebcdic/katakana`（SBCS 部のみ）、`codecForCcsid` → `@as400web/ebcdic/codec`
  - **`import` は消していない**——`screen/` `protocol/` `session/` が内部で EBCDIC を使うのは正当。
    禁じるのは `export … from "@as400web/ebcdic"` の形だけ
  - **実測値（次に測る人の基準線）**: web-ui 本番バンドル **359,857 バイトで前後一致**、
    DBCS 表（`ibm-1399` / `ibm-37` / `ibm-273`）は 0 件、テスト **3,269 → 3,271 件**（失敗 0）
  - **入口の指定そのものを走査で固定した**（`tn5250/test/ebcdic-not-reexported.test.ts`）。
    バンドルサイズの実測は人が回すときにしか効かない——直前の項目 4 で
    `@as400web/scs` のバレルに向けて **4 倍（1,458,480 バイト）**にした実例があるので、
    「web-ui は `/catalog` `/katakana` `/codec` 以外を import しない」を恒久的な検査にした
  - **AGENTS.md の主旨を変えた**——従来「再輸出するなら列挙する」だったが、
    4 回の切り出しを経た結論は**「再輸出そのものを置かない」**
