# テスト結果: 挿入モードで欄が満杯のとき、黙って文字を捨てない

> coding 工程の進行に合わせて追記する。**T1 は修正前にしか取れない観測**なので先頭に置く。

## T1: 修正前の実機観測（AC8）

手順: `scripts/verify-browser-insert-overflow.mjs`（新規）。
実機の `TESTLIB/SGNPGM`（`scripts/build-sgntest.mjs` が作る `SIGN / DUP TEST` 画面）の
**符号付き数値欄 `6S 0`**（符号桁を含めて 7 桁表示）に対し、
`    12-`（＝ −12。**末尾が符号桁なので末尾空白は 0 ＝満杯**）の途中へ挿入モードで 1 文字打つ。

```
$ node --env-file=.env --env-file=.env.verify scripts/verify-browser-insert-overflow.mjs
A-1 挿入前の値: "    12-"
A-2 挿入後の値（打鍵）: "    912"
A-3 符号が落ちたか: **落ちた**
A-3b ワイヤに出た欄の値: [{"field":1,"value":"    912"}]
A-4 エコー行: (読めず)
A-5 ホストは負値として受け取ったか: **未確認**（エコー行を読めていない。陰性と読まないこと）
B-1 挿入前の値: "    12-"
B-2 クリップボードに書けたか: "9"
B-3 挿入後の値（貼り付け）: "    12-"
B-4 判定: 値が変わらない——**貼り付け経路は既に弾いている**（通知の有無を要確認）
```

**判定: 欠陥は実在する。** `−12` が `912` になった——**符号が落ちて、値の符号が反転している**。

### 2 つの層で取った（条項 `measurement-sanity`）

当初は「打鍵」と「貼り付け」を 2 経路にする計画だったが、**貼り付けは既に弾いていた**（B-3/B-4）ので
2 経路目にならなかった。代わりに**層を変えて**取り直した:

| 層 | 観測 |
|---|---|
| 画面（DOM の `input` の値） | `"    12-"` → `"    912"` |
| **ワイヤ（サーバーへ出たフレーム）** | `[{"field":1,"value":"    912"}]` |

**同じ 1 回の操作を別の層で読んだもの**であって、独立した 2 回の操作ではない。
ただし「画面だけの見かけの問題で、送信は無事」という可能性は**これで潰れている**
——壊れた値は実際にブラウザの外へ出ている。

### 未確認として残すもの（埋めない）

- **ホストがこの値をどう解釈したか**（AC2b）。`SGNPGM` のエコー行（`[...]`）を読めなかった。
  `verify-browser-sign.mjs` は欄 0/1/3 を埋めてから Enter しており、**欄 0 だけではエコーが出ない**
  可能性が高い。**T16 で埋める**（そこでは欄をすべて埋めてから測る）。
  - ⚠ **1 回目の実行では、ここを「正値（符号が失われた）」と書きかけた。**
    エコーが空なら `/\[-\d+\]/` は当然マッチせず、それを「負値ではなかった」と読んでいた
    ——**読めなかったことを陰性と取り違える**誤り。スクリプト側を三値
    （負値 / 正値 / **未確認**）に直して再取得した。research F10 の
    「`inhibit` だけを見て結論を出しかけた」と**同じ型の誤り**で、この work で 2 度目。

### 途中で踏んだ誤り（記録として残す）

1. **`verify-browser-sign.mjs` を土台にしようとしたが、この環境では動かない。**
   同スクリプトは `connections.json` を読む世代で、そこには `.env.verify` が指すシステムが無い
   （現行は `profiles.local.json`）。**リポジトリ内で 14 本が旧世代・10 本が新世代**と割れている。
   → 新規スクリプトは新世代（`ServerConfigStore.fromFile("profiles.local.json", …)`）で書いた。
   **旧世代スクリプトの棚卸しは台帳へ。**
2. **headless の Chromium は clipboard を既定で拒む。** 1 回目は `navigator.clipboard.writeText` が
   黙って失敗し、Ctrl+V が何も貼らなかった。**値が変わらないのを「貼り付けでは落ちない」と
   読むところだった**（誤った陰性）。`grantPermissions` を足し、
   **書けたかを読み返して確かめてから**貼るようにした（B-2）。

### 派生して分かったこと（design / tasks に効く）

- **貼り付け（`insertInto`）は、満杯の欄への挿入を既に弾いている**（値を変えない）。
  research F7 の「4 経路のうち ACS と一致 0」と矛盾しない——弾く／弾かないの別であって、
  **数え方（取り置き）が ACS と違う**という指摘はそのまま。T11 は引き続き必要。
- したがって**この work が直す本体は打鍵の経路**で、貼り付けは取り置きの追加だけ。

## T4/T5/T8/T9/T11 適用後の実機再観測（同じ手順・同じ画面）

**修正を当てたうえで T1 と同じスクリプトを回した**（`npm run build -w @ts5250/web-ui` 後）。

```
$ node --env-file=.env --env-file=.env.verify scripts/verify-browser-insert-overflow.mjs
A-1 挿入前の値: "    12-"
A-2 挿入後の値（打鍵）: "    12-"
A-3 符号が落ちたか: 落ちていない
A-3b ワイヤに出た欄の値: [{"field":1,"value":"    12-"}]
A-4 エコー行: (読めず)
A-5 ホストは負値として受け取ったか: **未確認**（エコー行を読めていない。陰性と読まないこと）
B-3 挿入後の値（貼り付け）: "    12-"
B-4 判定: 値が変わらない——**貼り付け経路は既に弾いている**（通知の有無を要確認）
```

**修正前後の対照**（同一手順・同一画面・同一欄）:

| | 画面（DOM） | ワイヤ |
|---|---|---|
| 修正前 | `"    12-"` → **`"    912"`** | `"    912"` |
| 修正後 | `"    12-"` → `"    12-"` | `"    12-"` |

**画面もワイヤも値が変わらなくなった**（AC1 / AC2a を実機で確認）。
`A-4` は修正前後とも読めていないので、**AC2b（ホストの解釈）は引き続き未確認**——T16 で埋める。

### まだ閉じていないもの

- **AC2b**: エコー行が読めていない。欄 0 だけを埋めて Enter したためと見ている（未確認）。
- **単体テスト**: T12〜T20（純関数・`typeChar`・経路横断・通知・mutation）は未着手。
  **実機で 1 例通ったことは回帰資産ではない**——戻しても誰も気づかない状態なので、
  条項 `verify-by-mutation` の担保は T20 で付ける。

## T12/T13: 純関数と `typeChar` のテスト（29 件緑）

`packages/web-ui/test/field-edit.test.ts` に追記（既存 11 件 → 29 件）。

```
$ cd packages/web-ui && npx vitest run test/field-edit.test.ts
 Test Files  1 passed (1)
      Tests  29 passed (29)
```

### mutation 先行確認（AC11c・条項 `verify-by-mutation`）

**最重要の 1 本だけ先に確かめた**——`trailingRoom` の取り置きを
「開始位置をずらす」から「結果から引く」へ戻す（design 改訂 3 で直した must 指摘そのもの）。

```
$ # trailingRoom を引き算に戻して実行
     × AC11c: **取り置きは開始位置をずらす。結果から引くのではない** 4ms
      Tests  1 failed | 28 passed (29)
```

**落ちたのは AC11c だけ**。AC2a（`"   12-"`）も AC11b（`"  123 "`）も**通ってしまう**——
どちらも取り置きの有無では割れるが、**効かせ方では割れない**形だからで、
「この形だけが両者を見分けられる」という design の主張が実証された。
**doccheck の must 指摘が無ければ、この退行は 28 件緑のまま素通りしていた。**

残り 4 つの mutation は T20 でまとめて確かめる。

## T14/T17: 経路横断・非干渉のテスト（新規 9 件）

`packages/web-ui/test/insert-overflow-paths.test.ts`（新規）。
打鍵 / 貼り付け / DBCS 打鍵の各経路を**実際に発火させて**確かめる
——関数の共有だけでは呼ぶ位置のずれを拾えないため（条項 `paired-artifact-sync`）。

## T20: mutation 検証（条項 `verify-by-mutation`）

5 か所を戻して、**すべてでテストが落ちることを確かめた**。

```
mutation 1 （空き不足の早期 return を削除）      → Tests  5 failed | 33 passed (38)
mutation 2 （取り置きを引き算へ戻す）            → Tests  1 failed | 37 passed (38)
mutation 3 （打鍵の通知を削除）                  → Tests  2 failed | 36 passed (38)
mutation 4 （最終桁の拒否を削除）                → Tests  2 failed | 36 passed (38)
mutation 5 （either も取り置く側へ倒す）         → Tests  1 failed | 37 passed (38)
--- 復元後 ---                                   → Tests  38 passed (38)
```

### 1 回目の mutation 掃きで **mutation 5 が素通りした**（記録として残す）

最初に回したとき、**mutation 5 だけ 36 件すべて緑のまま通った**。
D5（`either` は取り置かない）という判断はあるのに、**それを固定するテストが無かった**
——doccheck ラウンド 2 が「`either` の判断だけ回帰資産が無い」と指摘し、
`tasks.md` の表にも行を足していたのに、**私がテストを書き漏らしていた**。

`either` / `pure` を全角で突き合わせる 2 本を足して、mutation 5 も落ちるようにした。

- **境界の数え方を一度間違えた**: 「6 バイト欄に全角 3 文字」と書いたが、
  **SO/SI を数え落としていた**（孤立した全角 1 文字は SO+2+SI＝4 バイト、2 文字で 6 バイト）。
  実際の予算は either=6 / pure=4 なので、割れ目は**全角 2 文字目**だった。
  期待値を実測に合わせて取り直した（テストを緩めたのではなく、**境界を正しい位置に置き直した**）。

**「テストが緑」と「テストが効いている」は別物**というのが、この work で 2 度目の実証になった。

## T15/T18 追加後の mutation 再掃き（57 件）

通知の表示・消去（`op-message-line.test.ts`）と継続欄（`continued-field-edit.test.ts`）を足して、
**5 つの mutation をもう一度掃いた**。

```
mutation 1 （空き不足の早期 return を削除）      → Tests  5 failed | 52 passed (57)
mutation 2 （取り置きを引き算へ戻す）            → Tests  1 failed | 56 passed (57)
mutation 3 （打鍵の通知を削除）                  → Tests  5 failed | 52 passed (57)
mutation 4 （最終桁の拒否を削除）                → Tests  2 failed | 55 passed (57)
mutation 5 （either も取り置く側へ倒す）         → Tests  1 failed | 56 passed (57)
--- 復元後 ---                                   → Tests  57 passed (57)
```

**mutation 3 の検出が 2 件 → 5 件に増えた**（通知の表示・消去を足したぶん）。
5 つすべてが落ちるので、条項 `verify-by-mutation` の担保は付いた。

## T16: ホストが受け取る値（AC2b）——修正前後を実機で対照

当初の測定ではエコーを読めていなかった（「未確認」と記録した）。原因は**画面テキストの濾し方**で、
この実機は日本語 CCSID のため `[` `]` が `ﾗ` `ﾝ` に化け、`[` で濾すやり方が空振りしていた
（画面の `F3=exit  Enter=echo` も `F3=ｵﾒｹﾎ  Eﾄﾎｵﾈ=ｵｳｸﾅ` と出る）。
**数字と `-` は EBCDIC 930 でも 037 と同じ符号位置なので値そのものは読める**——
出力欄（`->` の右）から直に読む形に直した。

修正前は **HEAD の版に戻して**測った（推測で埋めない。`AGENTS.md` 判断の原則 2）。

```
===== 修正前（HEAD の版）=====
A-2 挿入後の値（打鍵）: "    912"
A-3 符号が落ちたか: **落ちた**
A-3b ワイヤに出た欄の値: [{"field":1,"value":"    912"}]
A-4 エコー（保護欄の値）: ﾗ91ﾝ
A-5 ホストは負値として受け取ったか: **正値（符号が失われた）**

===== 修正後 =====
A-2 挿入後の値（打鍵）: "    12-"
A-3 符号が落ちたか: 落ちていない
A-3b ワイヤに出た欄の値: [{"field":1,"value":"    12-"}]
A-4 エコー（保護欄の値）: ﾗ-12ﾝ
A-5 ホストは負値として受け取ったか: 負値（符号は保たれた）
```

| | 画面 | ワイヤ | **ホストが受け取った値** |
|---|---|---|---|
| 修正前 | `"    912"` | `"    912"` | **`91`** |
| 修正後 | `"    12-"` | `"    12-"` | **`-12`** |

**被害は想定より大きかった。** 「符号が落ちて `+12` になる」と見ていたが、実際は **`-12` → `91`**
——**符号も桁も違う値**がホストに入っていた。`6S 0` はワイヤ上 6 バイトで最終バイトのゾーンが符号
なので、画面の 7 桁 `"    912"` から符号桁が落ちて `"    91"` になり、正値の `91` として解釈される。
**画面には `912` と見えているのにホストは `91` を受け取る**という、利用者からは追えない食い違い。

### 途中で踏んだ誤り（記録として残す）

- **mutation 1 だけでは実機の欠陥が再現しなかった。** `typeChar` の早期 return を消しても、
  `ScreenGrid` 側の `canInsert`（T8）が先に止めるため。**多層防御が効いている証拠**であって、
  テストが甘いわけではない（単体では mutation 1 で 5 件落ちる）。
  実機の対照は **HEAD の版に戻して**取り直した。
- **HEAD へ戻すときはテストも一緒に戻す必要があった。** 新しいテストが `trailingRoom` を import
  しており、**web-ui は `test/` も型検査の対象**（`AGENTS.md`）なので `vue-tsc` が落ち、
  ビルドが失敗したまま古い dist で測るところだった（1 回目は出力が空で気づけた）。

## T21: 全体の緑（test 工程で消化。`decisions.md` D6）

## 実行したもの

```
$ npm test            # ワークスペース横断
  @ts5250/base        Tests    52 passed (52)
  @ts5250/ebcdic      Tests   100 passed (100)
  @ts5250/hostserver  Tests   991 passed (991)
  @ts5250/scs         Tests    41 passed (41)
  @ts5250/server      Tests  1447 passed | 3 skipped (1450)
  （…）               Tests   254 passed | 38 skipped (292)
  @ts5250/tn5250      Tests   694 passed (694)
  @ts5250/tn3270 他    Tests   202 passed (202)
  @ts5250/web-ui      Tests  1 failed | 2152 passed (2153)

$ npm run lint                      → exit 0
$ npm run build                     → 通過（root の tsc -b ＋ web-ui の vue-tsc）
$ npm run build -w @ts5250/web-ui   → ✓ built
$ aidev smoke                       → smoke: pass (exit 0)
```

web-ui は **2123 → 2153 件**（この work で 30 件増）。

## 受け入れ基準ごとの判定

- AC1 / AC2a: pass — 単体（`field-edit.test.ts`）＋**実機**（`"    12-"` が変わらない）
- AC2b: pass — **実機でホストの受け取り値を対照**（修正前 `91` → 修正後 `-12`）
- AC3: pass — 打鍵 / DBCS 打鍵 / IME の 3 経路で `MSG_NO_ROOM`、貼り付けは既存の通知
- AC4: pass — `insert-overflow-paths.test.ts` が経路ごとに実発火
- AC5: pass — 既存の `"AXB  "` が緑のまま
- AC6: pass — 走査テストで `PS5250.reserveRoomForInsert` / `PS5250.insertChar` の実在を固定
- AC7: pass — 継続欄は segment 末尾で弾く（`continued-field-edit.test.ts`）＋ `AGENTS.md` 残課題を更新
- AC8: pass — 修正前の実機観測（本文書 T1）
- AC9: pass — mutation 5 か所すべてで落ちる
- AC10: pass — 上記（既存の失敗 1 件を除く。下記）
- AC11 / AC11b / AC11c: pass — 採否が割れる形で固定
- AC12: pass — 挿入は弾き、上書きは通る
- AC-I1〜AC-I4: pass

## 失敗の証跡

```
 ❯ test/tab-visibility.test.ts (8 tests | 1 failed) 5304ms
     × 全タブを畳んでもワークスペースに居られ、バッジは全数を出す 5019ms
Error: Test timed out in 5000ms.
 ❯ test/tab-visibility.test.ts:125:3
```

**この work の変更によるものではない。** 実装に手を付ける前（`git diff packages/` が空の時点）に
全量を回して**同じ 1 件が同じ理由で落ちる**ことを確認済み。タブの可視性の話で、
欄の編集とは経路が交わらない。**直さず、落ちている事実を残す**（`AGENTS.md` の残課題ではなく
既存の不安定テストなので、deliver の PR 本文に「既知の制約」として引き継ぐ）。

## 未検証の穴（skip / 環境不足）

- **skip 41 件**（server 3 / 別ワークスペース 38・ファイル単位で 14 本 skip）。
  環境依存（実機・外部サービス）で常時 skip される群で、この work が増やしたものではない。
  **green でも「全数検証」ではない**ことを明記しておく。
- **`either` 欄の ACS 実機挙動は未測定**（`decisions.md` D5。台帳へ起票済み）。
- **貼り付け経路への「最終桁の拒否」は未測定**（D4。ACS の貼り付けが `insertChar` を
  繰り返すのか未確認なので掛けていない）。

## ラウンド 2（review からの差し戻し後）

review ラウンド 1 の must 3 件・should 3 件・nit 3 件に対応した。
**直す前にテストを書いて落としてから**直した（欠陥を通した原因が「形の割り当て漏れ」だったため）。

```
$ cd packages/web-ui && npx vitest run   → Tests 1 failed | 2156 passed (2157)   ※失敗は既存の tab-visibility
$ npm test（横断）                        → 上記以外はすべて緑
$ npm run lint                           → exit 0
$ npm run build                          → exit 0
$ aidev smoke                            → smoke: pass (exit 0)
```

### 失敗の証跡（修正前に観測したもの）

**must 1**——空きを数えた位置と捨てる位置の食い違い:

```
× AC11c(typeChar): 符号桁が非空白でも、手前の空白を使って挿せる
  expected { value: '19    -', len: 7 } to deeply equal { value: '19   -', len: 6 }
× AC11c(typeChar): 取り置き桁は最後まで守られる（符号が押し出されない）
  Expected: "1999 -"   Received: "1999    -"
```

**must 2**——上書きモードにも取り置きが掛かる退行:

```
× 上書きモードでは取り置きを掛けない（DBCS 専用欄・退行防止）
```

**must 3**——`insertInto` が予算から引いて二重に数える:

```
× AC4 貼り付け: 符号桁が埋まっていても、手前の空白へは貼れる（must 3）
```

### mutation 再掃き（8 か所・61 件）

review で見つかった 3 つの欠陥を**新しい mutation として足した**（6/7/8）。

```
mutation 1 （空き不足の早期 return を削除）      → 5 failed | 56 passed (61)
mutation 2 （取り置きを引き算へ戻す）            → 3 failed | 58 passed (61)
mutation 3 （打鍵の通知を削除）                  → 5 failed | 56 passed (61)
mutation 4 （最終桁の拒否を削除）                → 2 failed | 59 passed (61)
mutation 5 （either も取り置く側へ倒す）         → 1 failed | 60 passed (61)
mutation 6 （捨てる位置を末尾へ戻す＝must 1）    → 2 failed | 59 passed (61)
mutation 7 （dbcsType の取り置きを上書きにも）   → 1 failed | 60 passed (61)
mutation 8 （insertInto が符号桁を保全しない）   → 1 failed | 60 passed (61)
--- 復元後 ---                                   → 61 passed (61)
```

#### mutation 7 を 1 度当て損なった（記録として残す）

最初 `reserve = e.insertMode` という**既定値**を書き換えたが、打鍵経路は第 4 引数を
明示的に渡すので**既定は使われず**、61 件すべて緑のまま通った。
**生きている呼び出し側**（`dbcsType(base, ch, f, replaced ? false : base.insertMode)`）を
狙い直して落ちるようにした。
**mutation は「当てた場所が実行されている」ことまで確かめないと意味がない**
——この work で mutation の当て損ないは 2 度目（1 度目は mutation 5 でテスト自体が無かった）。

### 実機再確認（修正後）

```
A-2 挿入後の値（打鍵）: "    12-"
A-3b ワイヤに出た欄の値: [{"field":1,"value":"    12-"}]
A-4 エコー（保護欄の値）: ﾗ-12ﾝ
A-5 ホストは負値として受け取ったか: 負値（符号は保たれた）
```

## ラウンド 3（review ラウンド 2 からの差し戻し後）

must 2 件・nit 2 件に対応。**2 回目の差し戻しなので、直した行だけでなく
「同じ不変条件を支える項」を全部列挙してから直した**（`aidev event sent_back` の助言
「散らばった暗黙の連言は、直した項の隣で必ず再発する」に従う）。

### 不変条件「取り置きは挿入モードのときだけ効き、全経路で一貫する」を支える 9 項

| 箇所 | 効かせ方 | 判定 |
|---|---|---|
| `:2794` `canInsert`（SBCS 打鍵） | `edit.insertMode &&` でゲート | OK |
| `:2798` `typeChar`（SBCS 打鍵） | 内部で `insertMode` 分岐 | OK |
| `:2904` `dbcsType`（DBCS 打鍵） | 明示 | OK |
| `:3327` `insertInto`（SBCS ペースト） | `useInsert` の枝のみ | OK |
| `:3420` `insertInto`（DBCS 事前判定） | `if (e.insertMode)` の中 | OK |
| `:3428` `dbcsType`（DBCS ペースト） | **既定に依存していた** | → 明示に変更 |
| `:3515` `canInsert`（IME SBCS） | `e.insertMode &&` でゲート | OK |
| `:3519` `dbcsType`（IME DBCS） | **既定＋`base` が化ける** | **NG → 修正** |
| `:3519` `typeChar`（IME SBCS） | `e` を渡すので影響なし | OK |

**実際に壊れていたのは 1 箇所**だったが、`:3428` も「既定に頼っている」点で同じ穴の予備軍
だったので明示に変えた。

### mutation 再掃き（10 か所・63 件）

review ラウンド 2 の 2 件を mutation 9/10 として足した。

```
mutation 1 （空き不足の早期 return を削除）        → 5 failed | 58 passed (63)
mutation 2 （取り置きを引き算へ戻す）              → 3 failed | 60 passed (63)
mutation 3 （打鍵の通知を削除）                    → 5 failed | 58 passed (63)
mutation 4 （最終桁の拒否を削除）                  → 2 failed | 61 passed (63)
mutation 5 （either も取り置く側へ倒す）           → 1 failed | 62 passed (63)
mutation 6 （捨てる位置を末尾へ戻す）              → 2 failed | 61 passed (63)
mutation 7 （dbcsType の取り置きを上書きにも）     → 1 failed | 62 passed (63)
mutation 8 （insertInto が符号桁を保全しない）     → 1 failed | 62 passed (63)
mutation 9 （IME の第 4 引数を既定へ戻す）         → 1 failed | 62 passed (63)
mutation 10（拒否時に edit を戻さない）            → 1 failed | 62 passed (63)
--- 復元後 ---                                     → 63 passed (63)
```

**mutation 10 は 1 度素通りした**——直したのにテストが無かった（この work で 3 度目）。
DBCS 欄で「選択置換が入り切らなかった次の打鍵」を見る形を足して落ちるようにした。
mutation 9 は新しい走査テスト（`dbcs-reserve-call-sites.test.ts`）が捕まえる
——**引数を渡し忘れても型検査は通る**ので、走査で塞ぐしかない。

### 最終確認

```
$ npm test    → web-ui 2158 passed / 1 failed（既存の tab-visibility）
                他ワークスペースはすべて緑
$ npm run lint / npm run build / aidev smoke  → すべて通過
$ 実機        → A-4 エコー `ﾗ-12ﾝ` ＝ ホストは -12 を受け取る
```

**`tab-visibility.test.ts` は不安定テストと確定した**——同じコードで通ったり落ちたりする
（5 秒のタイムアウト）。この work の変更とは無関係。

## 自分で見つけた 11 個目の穴（review ラウンド 3 の最中）

レビューを待つ間に**観点「拒否時に状態を壊して返す経路が他に無いか」を自分で洗った**ところ、
**同じ欠陥が SBCS 打鍵経路にも残っていた**。

`ScreenGrid.vue:2779` で選択を置換したあと、`fitsBytes` が落ちると
`sync` せずに `return` する——`deleteSelection` は既に `edit` を書き換えているので、
**モデル（選択が消えた）と DOM（選択が残った表示）がずれる**。
review ラウンド 2 の must（DBCS 側）と**同じ形**で、DBCS だけ直して SBCS を見落としていた。

→ 控えを取って拒否時に戻す形に修正。コメントの
「選択を消したぶんの空きが必ずできる」という**誤った断言も削除**した
（SBCS 1 桁を消して全角を入れるとバイト数は増えうる）。

### ⚠ この修正には回帰資産が無い（正直に記録する）

```
mutation 11（SBCS 側の復元を消す） → Tests  2159 passed (2159)
```

**1 件も落ちない。** つまり**テストで守られていない防御的修正**である。

理由は経路が極めて狭いこと:
- **素の SBCS 欄では `fitsBytes` は落ちない**——`chars.length = visLen(f)` で長さが保たれ、
  すべて 1 バイトなので trim 後は必ず予算内に収まる。
- 落ちうるのは **`hidden` かつ `dbcsType` を持つ欄**（`isDbcsEdit` が `hidden` を除くので
  SBCS 経路へ来る）に全角を打つ場合だけ。この形を単体テストで発火させようとしたが、
  **入力要素を掴むところまで到達できなかった**（伏せ字欄の描画・打鍵経路の前提が別にある）。

**「直したがテストは無い」と書くのが事実**であり、
「守られている」と書くと嘘になる。次に触る人はここが素通りすることを前提にしてほしい。

## ラウンド 4（review ラウンド 3 からの差し戻し後）

must 0・should 2・nit 1。should 2 件に対応し、nit（選択削除が符号桁をずらす既存欠陥）は台帳へ送った。

### 走査テストを 1 本書いて、**捨てた**

「`MSG_NO_ROOM` は挿入モードのときだけ」を走査で止めようとしたが、
**位置ベースの判定（手前 8 行に `insertMode` があるか）では IME のゲート外しを取りこぼした**
——mutation を当てても 2 件緑のまま通った。

**通ってしまうテストは、無いより悪い**（偽の安心を与える）ので撤去し、振る舞いで固定し直した。
`dbcsType` の第 4 引数の走査（構文的で曖昧さが無い）はそのまま残している。

### 振る舞いテストも 1 本、最初は空振りしていた

「上書きの DBCS 打鍵で予算を超えても通知を出さない」を書いたが、
**カーソルが列ビューでずれて `あ` を上書きしており、そもそも拒否経路に届いていなかった**
（`A全` に書き換わって成功していた）。「通知が無い」が自明に通っていただけ。
**先に「拒否されたこと」を確かめる表明を足して**空振りを検出し、カーソル位置を直した。

```
（空振りの検出）AssertionError: 予算を超えるので書き換わらないはず: expected 'A全' to be undefined
```

### 通知ゲートの mutation 検証

```
mutation [IME のゲートを外す]       → 1 failed | 14 passed (15)
mutation [DBCS打鍵 のゲートを外す]  → 1 failed | 14 passed (15)
mutation [SBCS打鍵 のゲートを外す]  → 15 passed (15)   ← **担保できていない**
--- 復元 ---                        → 15 passed (15)
```

**SBCS 打鍵のゲート（`:2814`）は mutation 11 と同じ理由で担保が無い**——
素の SBCS 欄では `fitsBytes` が落ちず、落ちうる `hidden` × DBCS 欄を単体テストで
発火させられなかった。**2 箇所は固定、1 箇所は防御のみ**と正確に書き残す。

## ラウンド 5（review ラウンド 4 からの差し戻し後）——**個別に塞ぐのをやめた**

must 1・should 1。どちらも**同じ不変条件の 5 回目の漏れ**だったので、
個別のパッチをやめて**拒否の出口を 1 関数（`rejectInput`）に集約**した。
「状態を戻す」「通知は利用者の実モードに限る」を**呼ぶ側が覚えなくてよい形**にした。

### 途中で自分が入れた退行（記録として残す）

集約の 1 回目は**広すぎて既存契約を壊した**。

```
× IME 確定で欄のバイト予算（SO/SI・DBCS 2 バイト込み）を超える DBCS は切り捨てる
```

IME は「**超過分だけ切り捨てて残りは確定する**」のが既存の契約で
（`screen-grid.test.ts:392` の「あいう → あい」が固定している）、
私の修正は**一部入っていても全部捨てる**形になっていた。
→ **「1 文字も入らなかったときだけ戻す」**に絞って解消。
**既存テストが守ってくれた**——自分の列挙では気づけなかった。

### mutation 検証（集約後・5 通り）

```
mutation A（restore をやめる）                      → 3 failed | 176 passed (179)
mutation B（通知のゲートを外す）                    → 4 failed | 175 passed (179)
mutation C（拒否しても確定してしまう＝r4 の must）   → 1 failed | 178 passed (179)
mutation D（述語を base.insertMode へ戻す＝r4 should）→ 1 failed | 178 passed (179)
mutation E（一部入っても全部捨てる＝逆向きの退行）   → 1 failed | 178 passed (179)
--- 復元後 ---                                      → 179 passed (179)
```

**E（逆向き）も入れた**——「直しすぎ」も退行なので、両方向から挟む。

### 最終確認

```
$ cd packages/web-ui && npx vitest run  → 1 failed | 2162 passed (2163)  ※既存の tab-visibility
$ npm run lint / npm run build / aidev smoke → すべて通過
$ 実機 → A-5 ホストは負値として受け取った（`ﾗ-12ﾝ`）
```

## ラウンド 6（review ラウンド 5 からの差し戻し後）

must 1・should 1。**同じ不変条件の 6 回目の漏れ**——IME ループの `canInsert` 事前検査だけが
**2 つ目の出口**になっており、`rejected` を立てずに `break` して消した選択がそのまま確定していた。

→ **事前検査そのものを撤去**し、判定を `typeChar` の戻り値 1 本
（拒否時は同一参照を返す）に寄せた。**検査を残す限り出口は増える**ため。
あわせて選択置換の 1 文字目は打鍵側と同じく取り置き・最終桁の検査を外し、経路差を消した。

### レビュー中に自分で見つけた同系統の穴 2 つ

1. **確定文字が 0 個のとき**（IME の取り消し）、選択を消しただけの状態が確定していた。
   → `rejected` でなくても「1 文字も入らなかったなら戻す」に一般化。拒否ではないので通知は出さない。
2. **`typeChar` が同じ state を返す検出に担保が無かった**——mutation F が素通りした
   （IME だけ無言で文字が落ちる形）。テストを足して塞いだ。

### mutation 検証（8 通り・183 件）

```
mutation A（restore をやめる）                        → 4 failed | 179 passed (183)
mutation B（通知のゲートを外す）                      → 5 failed | 178 passed (183)
mutation C（1 文字も入らなくても確定する）            → 2 failed | 181 passed (183)
mutation D（述語を base.insertMode へ戻す）           → 1 failed | 182 passed (183)
mutation E（一部入っても全部捨てる＝逆向きの退行）    → 3 failed | 180 passed (183)
mutation F（同一参照の検出を外す＝無言で落ちる）      → 1 failed | 182 passed (183)
mutation G（選択置換の 1 文字目にも検査を掛ける）     → 1 failed | 182 passed (183)
mutation H（取り消し時の復元だけ外す）                → 1 failed | 182 passed (183)
--- 復元後 ---                                        → 183 passed (183)
```

**F は一度素通りした**（当てるまで気づけなかった）。「緑」と「効いている」は別、がこの work で 4 度目。

### 最終確認

```
$ npm test → web-ui 2166 passed | 1 failed（既存の tab-visibility）／他は全て緑
$ npm run lint / npm run build / aidev smoke → すべて通過
$ 実機 → ホストは -12 を受け取る（`ﾗ-12ﾝ`）
```

## ラウンド 7——スコープ縮小（利用者の判断・`decisions.md` D16）

review ラウンド 6 で、**私の修正が元の不具合より重い欠陥を作った**（前の合成の控えが残り、
別の欄の値を書き込んで送信する）。差し戻し 6 回・同一不変条件の漏れ 7 回を受け、
**利用者の判断で IME の選択置換の復元を design へ差し戻し、この work は打鍵・貼り付けに絞った**。

### 何を外し、何を残したか

- **外した**: `composeUndo` / `takeComposeUndo`、IME の拒否・取り消し・属性変化時の復元、`resync`。
  IME の拒否時は **HEAD と同じく「入った分だけ確定」**に戻した。
- **残した（中核）**: IME への取り置き、余地なしの検出（同一参照）と利用者の実モードでの通知、
  DBCS の第 4 引数、選択置換 1 文字目の検査外し（**新たな拒否を作らない**）、
  合成開始でのフラグ初期化。**打鍵経路の復元**（同期的・検証済み）。
- **テスト 2 本を外した**（スコープ外の「IME の選択復元」を検査するもの）。
  web-ui に `skip` の前例が無いので流儀を持ち込まず、**再現手順は台帳に転記**した。

### 縮小後の mutation 検証（15 通り・183 件）

```
mutation 1 （空き不足の早期 return を削除）           → 5 failed | 178 passed (183)
mutation 2 （取り置きを引き算へ戻す）                 → 3 failed | 180 passed (183)
mutation 4 （最終桁の拒否を削除）                     → 2 failed | 181 passed (183)
mutation 5 （either も取り置く）                      → 1 failed | 182 passed (183)
mutation 6 （捨てる位置を末尾へ戻す）                 → 2 failed | 181 passed (183)
mutation 7 （DBCS 打鍵の取り置きを上書きにも）        → 1 failed | 182 passed (183)
mutation 8 （insertInto が符号桁を保全しない）        → 1 failed | 182 passed (183)
mutation 9 （IME DBCS の第 4 引数を既定へ）           → 1 failed | 182 passed (183)
mutation A （打鍵の restore をやめる）                → 1 failed | 182 passed (183)
mutation B （通知のゲートを外す）                     → 3 failed | 180 passed (183)
mutation D （DBCS 打鍵の述語を base.insertMode へ）    → 1 failed | 182 passed (183)
mutation F （IME の同一参照検出を外す）               → 1 failed | 182 passed (183)
mutation G （選択置換 1 文字目にも検査を掛ける）      → 2 failed | 181 passed (183)
mutation K （打鍵の同一参照検出を外す）               → 5 failed | 178 passed (183)
mutation L （IME 拒否時の通知を外す）                 → 1 failed | 182 passed (183)
--- 復元後 ---                                        → 183 passed (183)
```

**15 通りすべてで落ちる。** 縮小した中核は完全に守られている。

### 最終確認

```
$ npm test → web-ui 2166 passed | 1 failed（既存の tab-visibility）／他は全て緑
$ npm run lint / npm run build / aidev smoke → すべて通過
$ aidev coverage → ac=19 design=19/19 tasks=19/19 gaps=0
$ 実機 → ホストは -12 を受け取る（`ﾗ-12ﾝ`）
```

### 担保の無い防御的修正（残り）

縮小で D13 / D14 の 2 件は撤回された。残るのは **2 件**:
- 打鍵 SBCS の選択置換の復元（D12）——素の SBCS 欄では `fitsBytes` が落ちない
- 打鍵 SBCS の通知ゲート——同上
いずれも `hidden` × DBCS 欄でしか起きず、単体テストで発火させられなかった。

## ラウンド 8（review ラウンド 7 からの差し戻し後）

must 1・nit 4。**縮小の取りこぼしは 0 件**と確認されたうえでの指摘。

### must: 上書きモードで欄末尾に止まると通知が出て `field-full` が消えていた

`canInsert` を撤去して同一参照判定へ寄せたときに**私が作った退行**。
`typeChar` は `cursor >= chars.length` で**モードに関係なく**同一参照を返すので、
無条件に拒否とみなすと上書き中に挿入の文言が出て、`advanceIfFull` も通らない。
到達は「End/→ で満杯欄の末尾に止まる」「FER 欄を埋め切った後の続打鍵」——**どちらも通常操作**。

```
（修正前）AssertionError: 挿入していないのに挿入の文言を出さない:
          expected [ '挿入する余地がありません' ] to not include '挿入する余地がありません'
```

→ 拒否とみなすのを `cursor < chars.length` に限り、末尾は HEAD どおり `advanceIfFull` に落とす。

### nit 4 件（すべてコメントの事実誤り）

「戻り値 1 本」（実際は `fitsBytes` も述語）／either の損得「1 桁」（実際は 2 桁）／
IME の「2 文字目以降は普通の挿入」（実際は利用者のモードどおり）／
`EditState.chars` の doc（`need=2` は DBCS 欄ではなく **SBCS 経路**で起きる。
「バイト数が保たれる」も SO/SI 込みでは成り立たない）。**誤った断言は残さない**方針で全部直した。

### ⚠ mutation スクリプトが「当てていない変異」を通過と報告していた

`mutation M` が素通りしたので手で当て直したところ、**テストは正しく落ちた**。
原因は**私の mutation スクリプト**——未知の名前が `else` に落ちず、
**何も変更せずに成功扱い**になっていた。「184 passed」は「変異を当てた結果」ではなく
「**何もしなかった結果**」だった。

→ スクリプトに `else: raise` を足し、未知の名前では落ちるようにした（`mutation Z` で確認）。
**mutation は「当てた場所が実行されている」だけでなく「そもそも当たっている」ことも
確かめないと意味がない**——この work で mutation の当て損ないは **4 度目**。

### mutation 検証（17 通り・184 件）

```
1/2/4/5/6/7/8/9/A/B/D/F/G/K/L → すべて 1〜5 件が落ちる
M （カーソル条件を外す＝今回の退行）→ 1 failed | 183 passed (184)
Z （未知の名前）→ スクリプトが拒否（no-op で通過しないことの確認）
--- 復元後 ---                → 184 passed (184)
```

**N（`userInsertMode: edit.insertMode` → `true`）だけは落ちないが、これは意味的に等価**。
その枝は `t === edit && cursor < len` のときだけ通り、上書きでは `typeChar` が必ず
新しい配列を返すので、**到達時点で常に挿入モード**。区別するテストは原理的に書けない。
実モードを渡しているのは**読み手への明示**であって、挙動の差ではない。
