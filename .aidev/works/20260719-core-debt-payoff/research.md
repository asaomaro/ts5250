# 調査: core の負債 5 件の実測

requirement の「スコープ候補」5 件を、**推測せず数えた**結果。

## F1. `no-restricted-globals`（retro 2 回・未適用）

- `eslint.config.js` 全 44 行に **`no-restricted-globals` は存在しない**。Buffer に関する制限はゼロ。
- あるのは `no-restricted-imports`（`:31-44`）だけで、`packages/core/src/**` に対し
  `node:*` の import を禁止（`transport/**` と `log.ts` は除外）。
- **抜け道の実証**: `node:*` import は core/src 全体で 4 行のみ（すべて `transport/` 内＝許可済み）。
  一方 `Buffer` はグローバルなので import 不要で、**ピュア層で `Buffer.from()` と書いても
  現在の設定では検出されない**。
- ピュア層は今のところ明示的に回避している（`hostserver/signon.ts:67` に
  「バイト列を16進文字列にする（Node の Buffer に依存しない）」というコメントがある）が、
  **これは規律であって仕組みではない**。retro が 2 回とも指摘したとおり。

→ **やる価値が高い**。小さく、機械的に検証でき、再発を構造的に止める。

## F2. ロガー依存

| 項目 | 実測 |
|---|---|
| `pino` を import している箇所 | **`core/src/log.ts:1` の 1 箇所のみ** |
| `core` の dependencies | **`pino` のみ**（他に無い） |
| core 内で `childLog` を使うファイル | 7（**すべて `hostserver/` 配下**） |
| core 内の `log.*` 呼び出し | 14 箇所。**すべて `log.debug`** |
| ピュア層（protocol/screen/session/codec/telnet/trace）の log 使用 | **0** |
| server 内で core の `childLog` を使うファイル | 6（`ws-handler` / `audit` / `host-api` / `host-server-tools` / `session-manager` / `mcp-tools`） |
| server の `log` 直接 import | `main.ts:5` の 1 箇所 |

**backlog の「今なら数行で済む」は概ね正しい**が、注意点がある——
**server が core のロガーに乗っている**（6 ファイル）。core を no-op 既定にすると、
server 側のログ（**`audit.ts` の監査証跡を含む**）が静かに消えうる。

→ やる。ただし**「静かに消える」失敗モードを設計で潰す**必要がある（spec で扱う）。

## F3. `Tn5250Error` の改名

- 定義: `core/src/errors.ts:28`。継承は 3 つ（`SignonError` / `CommandError` / `SqlError`）
- 出現数: **合計 298 行**（core/src 169・core/test 45・server/src 76・server/test 2・tools 6・
  **web-ui 0**）

→ やる。**別名を維持すれば後方互換**で、機械的な置換で済む。web-ui が 0 件なのも軽い理由。

## F4. `ErrorCode` の整理 — **backlog の前提が誤っている**

backlog は「19 種に … ホストサーバーに無縁のものが混在」と書くが、実測すると:

- メンバーは **19 ではなく 21**
- **未使用のコードは 0 件。全 21 コードに生成箇所がある**

つまり「整理」＝不要なものを消す、という作業は**存在しない**。
実際に見つかった問題は backlog の記述とは別物である:

- 偏り: `PROTOCOL_ERROR` 65 / `CONFIG_ERROR` 33 / `CONNECT_FAILED` 22 で全体の約 41%
- **`CONNECT_FAILED` の意味が壊れている**——server 側で「限度到達」「参照不正」
  「users ファイルが読めない」など**接続と無関係な用途に 11 箇所**流用されている
- HTTP ステータスへの写像（`host-api.ts:40-46`）が明示的に扱うのは 5 コードだけ

→ **この作業ではやらない。** 「無縁のコードが混ざっている」ことより
   「**同じコードが別の意味で使い回されている**」ことのほうが実害があり、
   直すなら server 側の 11 箇所の意味を決め直す作業になる。性質が違うので分ける。
   backlog の記述自体を実測に基づいて**書き換えて**戻す。

## F5. CCSID テーブルの同梱

| ファイル | 行数 |
|---|---|
| `tables/ibm37.ts` | 174 |
| `tables/ibm273.ts` | 174 |
| `tables/ibm930.ts` | 4,794 |
| `tables/ibm939.ts` | 4,794 |
| `tables/ibm1399.ts` | 8,964 |
| **計** | **18,900 行 / 1.17 MB**（dist の js は 1,372 KB） |

**tree-shaking が効かない理由（実測）**:

- `codec.ts:2-6` が 5 テーブルすべてを**静的な値 import**（`import type` ではない）
- `codec.ts:161-173` がトップレベルで `new Map([...])` に全テーブルを詰めている
- `codec.ts:179-180` の `katakanaChar()` が `ibm930` を直接参照。
  **web-ui が `@as400web/core/codec` から import しているのはこの関数だけ**なのに、
  この 1 関数のために全 5 テーブルが到達可能になる
- `pure-dbcs.ts:10` が独立に `ibm1399`（557 KB）を静的 import
- 生成物は `tools/gen-tables` が **`.ts` として src に直接書き出し**ており、
  遅延ロード可能な形式（JSON 等）ではない

→ **この作業ではやらない。** 直すには (a) 遅延 import 化、(b) サブパス export の分割、
   (c) 生成物の形式変更、のいずれかが要り、**ブラウザのバンドル方法に影響する**。
   バンドルサイズを実測しながら進めるべき独立した作業で、lint 追加や改名と一緒にすると
   PR の性質が混ざる（requirement の「リスクの違うものを混ぜない」）。

## 結論: この作業のスコープ

| # | 項目 | 判断 | 理由 |
|---|---|---|---|
| 1 | `no-restricted-globals` | **やる** | 小さい・機械的に検証可能・retro 2 回未適用 |
| 2 | ロガー注入 | **やる** | pino は 1 箇所。ただし server への波及を設計で扱う |
| 3 | `As400Error` 改名 | **やる** | 別名維持で後方互換。web-ui は 0 件 |
| 4 | `ErrorCode` 整理 | **やらない** | backlog の前提が誤り（未使用 0 件）。実問題は別物 |
| 5 | CCSID テーブル | **やらない** | パッケージング変更でリスクの性質が違う |
