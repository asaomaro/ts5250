## review ラウンド1

- [must] `packages/tn5250/test/cells-signature.test.ts` と本ファイル
  （`review.md`）に、Docstring 中で「NUL」を説明する際に**リテラルの NUL バイト
  （U+0000）が誤って埋め込まれていた**（`git diff` がバイナリ差分として表示され、
  `file` コマンドが `data` と判定する状態）。テキストで示すべきところを実際の
  制御文字にしてしまったもので、機能的な破損は無かった（テスト自体は green）が、
  ソースファイルの健全性の問題として修正した（NUL バイトを除去し、通常の
  テキスト説明に置き換え）。全ての変更対象ファイルを NUL バイトの有無で
  横断確認し、他に混入が無いことを確認した。
  — 根拠: `packages/tn5250/test/cells-signature.test.ts`（修正前 バイト777付近）、
  `review.md`（修正前、T2(must)行付近）
- 要件適合・価値適合の観点（`requirements.md` の AC1〜AC8、目的/ゴール、
  ユーザーストーリーの価値）で別コンテキストによる点検を実施。指摘 0 件
  （`CHECK: ok`）。coding 工程のタスク単位・横断点検で既に正確性・規約適合は
  深く見ているため、この点検はそれらが見なかった2観点に絞って行った。

## review ラウンド2（deliver 後、CI で発覚）

- [must] deliver で PR #395 を作成後、CI（`offline` ジョブ、`npm run lint`）が失敗した。
  `scripts/diag-seu-page-cursor-edit.mjs:124` の `const d0 = await openEdit();` が
  未使用変数（`@typescript-eslint/no-unused-vars`）。review ラウンド1で
  `npx eslint` を打った対象が `session.ts`/`buffer.ts`/新規テスト2ファイルに
  限られており、research 工程で先に作った実機診断スクリプト4点を含めていなかった
  ため見落とした。修正（`await openEdit();` に変更、戻り値は元々未使用）のうえ、
  `npx eslint .`（リポジトリ全体）・`npm run build`・`npm test`
  （CI と同じコマンド、全ワークスペース）を実行し直し、全て green であることを
  確認した（tn5250: 594、web-ui: 2035、server: 1416+3skip、tn3270: 254+38skip、
  vt: 202、gen-tables: 10、hostserver-check: 0 件、いずれも failed 0）。
  — 根拠: CI run https://github.com/asaomaro/ts5250/actions/runs/34853725393
  （job: offline）、`scripts/diag-seu-page-cursor-edit.mjs:124`
- **教訓**: 差分に含めた新規ファイルの lint/build/test は、対象を絞らず
  `npx eslint .` / `npm run build` / `npm test`（CI と同一コマンド）で
  リポジトリ全体を通してから deliver するべきだった。次回以降の review 手順に活かす。

## タスク横断点検（coding 手順5.5、cross）

4件の指摘があった。
- (must, FFW未追跡の残存リスク) / (should, Attn/SysReq除外の副作用):
  いずれも T3 の2巡目で既に指摘・`decisions.md` D4 に記録済みの内容と同根。
  「60 review へ委ねる」という先送りの書き方だった点を指摘されたため、D4 を
  「この work では対応しないと確定する」という closed な決定に書き直し、
  該当コードにも残存リスクである旨のコメントを追加した（`session.ts` 新分岐末尾）。
- (should) `cursor-page-boundary.test.ts` の「AC2」テストが名称上 Rule1・Rule2 両方を
  指しているのに Rule1 しか検証していなかった。Rule2×PageUp のケースを追加し、
  テスト名も Rule1/Rule2 で明確に分割した。
- (should) T2（`cellsSignature()` の区切り文字修正）に対応する回帰テストが無かった。
  `cells-signature.test.ts` を新規追加し、DBCS（`dbcs-tail`）を含む実際の
  `applyDataStream` 経路で「順序が変わればsignatureも変わる」「同じ内容なら安定」を
  確認する（数学的な衝突不可能性の根拠と、実際の衝突再現が困難だった経緯もコメントに残す）。

## タスク横断点検（cross）2巡目（上限到達）

2件の指摘があった。
- (should) `decisions.md` D4 / 本ファイルの1巡目の記述が「両方の残存リスクにコード
  コメントを追加した」としていたが、実際には D4(1)（FFW未追跡）だけで、D4(2)
  （Attn/SysReq除外の裏返し）にはコメントが無かった。`session.ts` の `lastSentAid`
  更新箇所に D4(2) 用のコメントを追加し、記述と実装を一致させた。
- (should) design.md「振る舞いの詳細」の疑似コード・「受け入れ基準との対応」AC6 節が、
  coding 中に追加した `cursorBeforeWasEnterable`（Rule1・Rule2 共通のガード）を
  反映しておらず、AC6 の回帰しない根拠が古い記述のままだった。design.md の疑似コード・
  AC6 節を実装に合わせて更新し、「coding 中に判明した追加条件」として経緯を明記した。
  tasks.md T3 にも同様の実施結果を追記した。

## タスク点検ログ（coding 工程内・「3.3」(b)）

- T1: `lastSentAid` の更新を `buildAidRecord()` 呼び出し**前**から**後**（実際に送信する直前）へ移動。
  `buildAidRecord()` が例外を投げるケース（`SysReq` 以外への `sysReqText` 指定など）で、
  送信されなかったキーが `lastSentAid` に残ってしまう不整合を防ぐ。
  — 根拠: `packages/tn5250/src/session/session.ts:341-342,366`,
  `packages/tn5250/test/session.test.ts:267`, design.md「インターフェース / データ構造」
- T2 (must): `cellsSignature()` の連結に区切りを入れていなかったため、`dbcs-tail`
  （`char` が空文字）等の可変長・0長トークンが混在して衝突しうる状態だった
  （異なる2画面を「完全一致」と誤判定しうる）。各セルの前に表示文字として実在しない
  制御文字（NUL）を区切りとして挿入するよう修正。半角スペースは実際の
  `char` セル値になり得るため区切りには使わない。
  — 根拠: `packages/tn5250/src/screen/buffer.ts:834-857`
- T2 (should): `cellsSignature()` は TS に package-private が無く `session.ts` から
  呼ぶ都合上 public のままだが、`@internal` JSDoc タグを付けて対外 API ではないことを明示。
  — 根拠: design.md「振る舞いの詳細」節
- T3 (must): 新分岐（Rule1/Rule2）に `cursorBeforeWasEnterable` の条件が無く、送信**前**の
  時点で既に保護欄／欄外にいた場合、画面完全一致＋カーソル不動のケースで隣接する
  保護欄退避分岐（`PR#387`）と構造的に重なり、その退避を握りつぶしうる状態だった
  （AC6 の潜在的回帰）。送信前にカーソルが入力可能な欄にあったかを別途捕捉し、
  「保つべき良い位置がある場合」だけ新分岐が働くよう修正。無い場合は既存の
  保護欄退避分岐に判定を譲る。
  — 根拠: `packages/tn5250/src/session/session.ts:544-556,635-664`
- T3 (should): 新分岐のコメントが「下の2分岐ではこの不具合は直せない」と2分岐まとめて
  述べていたが、実際には1つ目（`!result.cursorSet`）にしか当てはまらない
  （2つ目＝保護欄退避は `cursorSet` の有無を問わない）。誤解を招く記述だったため訂正。
  — 根拠: `packages/tn5250/src/session/session.ts:642-648`
- T3 (should): `lastSentAid` の更新が Attn/SysReq を含む全 AID キーで無条件に行われており、
  PageUp/PageDown の応答待ち中に Attn/SysReq を挟むと、後で届く本来の応答に対して
  `isPageKey` が誤って false になり境界のカーソル位置保持が静かに効かなくなる問題があった。
  design.md の意図通り、Attn/SysReq では `lastSentAid` を更新しないよう修正（T1 の diff）。
  — 根拠: `packages/tn5250/src/session/session.ts:341-346`
- T4: `packages/tn5250/test/`, `packages/web-ui/test/` を横断検索した結果、
  PageUp/PageDown に言及する既存テストは web-ui 側に9ファイルあったが、いずれも
  `useKeymap`（ローカルのキー分類）のテストで、`Session5250`/`sendAid` を介した
  実際のセッションレベル挙動（今回変更した箇所）は経由していない
  （`sendAid` を参照するのは `keymap.test.ts` のみで、そこも `vi.fn()` によるモック）。
  影響なし。3ファイル（`cursor-default.test.ts`, `cursor-stale-on-protected.test.ts`,
  `screen-grid-cursor-restore.test.ts`）は green（`web-ui` は自パッケージの vitest 設定
  `npm run test -w @ts5250/web-ui` で実行——ルートから素の `vitest run` すると
  `.vue` ファイルの transform に失敗する。既知の実行方法で、今回の変更とは無関係）。
- T5 (should): `cursorBeforeWasEnterable` の必要性（T3 の must 指摘）を実際に PageUp/PageDown
  で踏む回帰テストが存在しなかった（`cursor-stale-on-protected.test.ts` は `Enter` のみで
  `isPageKey=false`）。送信前から保護欄にいる状態で PageDown し、既存の保護欄退避
  （`PR#387`）が正しく働くことを確認するケースを追加。ガードを一時的に外すと
  このケースだけが失敗することを確認済み。
  — 根拠: `packages/tn5250/test/cursor-page-boundary.test.ts`（AC6 回帰ケース）
- T3 (2巡目, should/nit・上限到達): `cellsSignature()` が FFW を比較に含まないため
  FFW だけ変わるケースで `PR#387` 分岐との重なりが理論上再発しうる点、および
  Attn/SysReq 除外の裏返しとして無関係なレコードに `isPageKey` が誤って true 判定
  されうる点の2件が残った。`maxTaskCheckRounds` の上限に達したため、
  この場では直さず `decisions.md` D4 に経緯を記録し、判断を 60 review に委ねる。
