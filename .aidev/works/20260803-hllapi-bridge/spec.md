# 仕様: HLLAPI / EHLLAPI 対応

前提: `requirement.md`、`research.md`（F1〜F9）。

## 概要

**既存の HLLAPI 資産が書き換えなしに ts5250 を駆動できる**ようにする。

```
既存資産（VB / C / VBA …）
   │  hllapi(int*, char*, int*, int*)      ← C ABI・同期（research F1）
   ▼
Rust cdylib（薄い接続層）                    ← **状態を持たない。C ABI ↔ HTTP だけ**
   │  POST /api/hllapi  {function, ps, data, length}
   ▼
packages/server（HLLAPI のロジック）          ← 機能番号の意味づけ・PS 走査・rc の決定
   │
   ▼
SessionManager → Session5250 / ScreenSnapshot（既存。MCP と同じ）
```

**「ロジックは TypeScript」を構造で担保する**——Rust 側に機能番号の意味を 1 つも書かない。
Rust が知っているのは「4 つのポインタを読んで JSON にし、返ってきた JSON を書き戻す」ことだけ。

## 設計方針

### 1. 1 呼び出し = HTTP 1 往復（Rust に状態も相関も持たせない）

HLLAPI は**同期 API**。セッション操作は WebSocket にしか無い（research F6）が、
WS は非同期・ストリーミングで相性が悪い。**MCP と同じく `SessionManager` を直接叩く
同期 REST を TypeScript 側に足す**。

- Rust はブロッキングで HTTP を投げて待つ。**接続の使い回しもしない**（1 呼び出し 1 接続）。
  localhost なので接続コストは小さく、**状態を持たない**ほうが要件に忠実。
- 接続先は環境変数 `TS5250_HLLAPI_URL`（既定 `http://127.0.0.1:3400/api/hllapi`。
  サーバーの既定ポートは 3400）。
- 認証が有効なら `TS5250_API_TOKEN` を `Authorization: Bearer` に載せる。

### 2. Rust は外部クレートを使わない

`std` だけで書く（`TcpStream` に HTTP/1.1 を直書き、JSON は交換する 4 項目だけの最小実装）。

- **利用者が Windows で自分でビルドする**ことを想定した部品なので、
  レジストリ取得なしにビルドできるほうが確実。
- 交換する形は 4 項目しかなく、手で書ける範囲。**エスケープ処理は単体テストで固める**。
- ただし**手書き JSON は誤りやすい**ので、`\"` `\\` `\n` `\t` `\uXXXX` の往復をテストで押さえる。

### 3. 短縮名（PS 名）は TypeScript 側が持つ

HLLAPI は `A`〜`Z` の 1 文字でセッションを指す。**対応表は TypeScript 側**（要件 FR-11）。

- `Connect (1)` のとき、その短縮名に**まだセッションが無ければ**、
  開いているセッションを**古い順に** `A` から割り当てる。
- 割り当て済みなら、そのセッションへ繋ぐ。
- **`Connect` で新しいホストセッションを開かない**——HLLAPI の Connect は
  「既にあるエミュレーターの画面に繋ぐ」意味だから。開くのは ts5250 側の役目。
  該当が無ければ `rc=1`（`HRC_PS_ID_INVALID`）。

### 4. 位置は 1 起点の通し番号

`pos = (row - 1) * cols + col`（`row`/`col` は 1 起点）。逆変換も同じ式。
`Convert Position or RowCol (99)` はこの換算をそのまま提供する。
範囲外は `rc=7`（`HRC_PS_POSITION_INVALID`）。

### 5. 実装する機能番号（research F2 の一次資料に従う）

| # | 機能 | 実装 |
|---|---|---|
| 1 | Connect Presentation Space | ○ |
| 2 | Disconnect Presentation Space | ○ |
| 3 | Send Key | ○（ニーモニック解釈つき） |
| 4 | Wait | ○ |
| 5 | Copy Presentation Space | ○ |
| 6 | Search Presentation Space | ○ |
| 7 | Query Cursor Location | ○ |
| 8 | Copy PS to String | ○ |
| 10 | Query Sessions | ○ |
| 15 | Copy String to PS | ○ |
| 18 | Pause | ○ |
| 20 | Query System | ○ |
| 22 | Query Session Status | ○ |
| 30 | Search Field | ○ |
| 31 | Find Field Position | ○ |
| 32 | Find Field Length | ○ |
| 33 | Copy String to Field | ○ |
| 34 | Copy Field to String | ○ |
| 40 | Set Cursor | ○ |
| 99 | Convert Position or RowCol | ○ |
| 9, 11, 12, 13, 14, 21, 23〜25, 50〜53, 90, 91 | Set Session Parameters / Reserve / Release / Copy OIA / … | **× → `rc=10`** |

**未実装は `rc=10`（`HRC_FUNCTION_UNAVAILABLE`）**——推測ではなく規約にある値（research F3）。

### 6. キーのニーモニック（research F4）

`@` 接頭辞のニーモニックを ts5250 のキー名へ写す。**写像は TypeScript 側の 1 か所**。

| ニーモニック | ts5250 | | |
|---|---|---|---|
| `@E` | `Enter` | `@1`〜`@9` | `F1`〜`F9` |
| `@T` / `@B` | `Tab` / `BackTab` | `@a`〜`@o` | `F10`〜`F24` |
| `@C` / `@F` / `@R` | `Clear` / `EraseEOF` / `Reset` | `@x`/`@y`/`@z` | `PA1`〜`PA3` |
| `@U`/`@V`/`@L`/`@Z` | カーソル 上/下/左/右 | `@0` | `Home` |
| `@A@H` / `@A@Q` | `SysReq` / `Attn` | `@@` | 文字の `@` |

**普通の文字はそのまま入力**（`"ABC@E"` = ABC を打って Enter）。
**写せないニーモニックは `rc=20`**（`HRC_UNDEFINED_COMBINATION`。規約にある値）。

> 5250 に無いキー（`PA1`〜`PA3` は 3270 のもの）は写せない。
> **黙って無視せず `rc=20` で断る**——「送ったつもりで送られていない」が最悪。

### 7. 文字コード

**境界は UTF-8**。`data_string` は UTF-8 のバイト列として扱い、EBCDIC / CCSID の変換は
既存の TypeScript 側に閉じる（Rust は文字を解釈しない）。

- 画面に DBCS（日本語）が含まれる場合、**1 セル = 1 文字**として扱う（全角も 1 セル）。
  HLLAPI の伝統的な実装は SBCS 前提で「全角は 2 バイト分の位置を占める」が、
  **ts5250 の `ScreenSnapshot` はセル単位**なので、そちらに合わせる。
  **この差は文書に明記する**（既存資産が桁位置を数えている場合に効く）。

## 対象範囲

### 追加

| 場所 | 内容 |
|---|---|
| `crates/hllapi/` | Rust の cdylib。C ABI ↔ HTTP のみ |
| `crates/hllapi/tests/` | JSON エスケープ・HTTP 組み立ての単体テスト |
| `packages/server/src/hllapi.ts` | 機能番号の意味づけ（**ロジックの本体**） |
| `packages/server/src/hllapi-keys.ts` | ニーモニック → キー名の写像（純関数） |
| `packages/server/src/hllapi-ps.ts` | PS の走査・位置換算（純関数） |
| `packages/server/src/hllapi-routes.ts` | `POST /api/hllapi` |
| `scripts/verify-hllapi-*.mjs` | C ABI での検証（Python ctypes を起動して叩く） |
| `docs/HLLAPI.md` | 対応表・制約・Windows ビルド手順 |

### 変更

| 場所 | 内容 |
|---|---|
| `packages/server/src/app.ts` | ルート登録 1 行 |
| `README.md` | HLLAPI 対応の記載 |

**既存のセッション操作には触れない**（`SessionManager` を読むだけ）。

## インターフェース / データ構造

### C ABI（`crates/hllapi`）

```rust
/// HLLAPI の標準エントリ。**4 引数すべてポインタ**（research F1）。
/// 実装ごとに名前が違うので別名も出す（`hllapi` / `HLLAPI` / `WinHLLAPI`）。
pub extern "C" fn hllapi(func: *mut c_int, data: *mut c_char, len: *mut c_int, rc: *mut c_int);
```

- `data` は**入出力兼用**。応答が入力より長ければ `len` の分だけ書き、`rc=6`（切り詰め）。
- `rc` は**入力時に PS 位置**を運ぶことがある（機能により）。そのまま TypeScript へ渡す。
- **ヌルポインタは `rc=2`**（`HRC_PARAMETER_ERROR`）。落とさない。
- **サーバーへ届かないときは `rc=9`**（`HRC_SYSTEM_ERROR`）。

### 交換する形（`POST /api/hllapi`）

```jsonc
// 要求
{ "function": 3, "data": "ABC@E", "length": 5, "pos": 0 }
// 応答
{ "rc": 0, "data": "…", "length": 12 }
```

`pos` は入力時の `return_code`（HLLAPI の規約で位置を運ぶ）。

### TypeScript 側の中核（`hllapi.ts`）

```ts
export interface HllapiRequest { function: number; data: string; length: number; pos: number }
export interface HllapiResponse { rc: number; data?: string; length?: number }

/** 機能番号で分岐する唯一の場所。**未実装は rc=10** */
export async function callHllapi(deps: HllapiDeps, req: HllapiRequest): Promise<HllapiResponse>;
```

`HllapiDeps` は `SessionManager` と短縮名の対応表を持つ（テストから差し替えられる形）。

## 振る舞いの詳細

| 機能 | 振る舞い |
|---|---|
| Connect (1) | `data[0]` が短縮名。対応表に無ければ**開いているセッションを古い順に割り当てる**。該当なし → `rc=1` |
| Disconnect (2) | 接続を解く（**セッションは閉じない**。HLLAPI の意味に合わせる） |
| Send Key (3) | ニーモニックを解釈して順に送る。キーボードロック中は `rc=5` |
| Wait (4) | キーボードのロックが解けるまで待つ。解けたら `rc=0`、時間切れは `rc=4` |
| Copy PS (5) | PS 全体を文字列で返す（行を連結） |
| Search PS (6) | 見つかった位置（1 起点）を `rc` に返す。無ければ `rc=24`…**ではなく `rc=7`**（規約は「見つからない」を位置無効で表す） |
| Copy PS to String (8) | `pos` から `length` 文字 |
| Query Sessions (10) | 短縮名・種別・状態の一覧 |
| Copy String to PS (15) | `pos` から書き込む。入力欄でなければ `rc=5` |
| Pause (18) | 指定時間待つ（更新があれば `rc=26`） |
| Query System (20) | 実装の識別情報 |
| Query Session Status (22) | 短縮名・画面サイズ・状態 |
| Search Field (30) / Find Field Position (31) / Length (32) | `snapshot.fields` を走査 |
| Copy String to Field (33) / Copy Field to String (34) | 欄単位の読み書き |
| Set Cursor (40) | カーソル位置を設定 |
| Convert Pos/RowCol (99) | 換算のみ（セッション不要） |

## ドメイン固有の考慮（AGENTS.md）

- **ログは stderr のみ**。`console.*` は lint で禁止。Rust 側も `eprintln!` に限る。
- **秘密を出さない**——HLLAPI はサインオン画面に文字を打つ。**`data` の中身をログに出さない**。
- **ピュアロジックを分ける**——`hllapi-keys.ts` / `hllapi-ps.ts` は純関数にして実機なしでテストする。
- **既存の認可方針を踏襲**——`/api/hllapi` は他の `/api/host/*` と同じ扱い（接続を持つ利用者なら可）。
- **依存を足さない**——Rust も `std` のみ。

## エラー処理 / 異常系

| 事象 | 戻り値 |
|---|---|
| ヌルポインタ | `rc=2` |
| サーバーへ届かない / 応答が壊れている | `rc=9` |
| 未実装の機能番号 | **`rc=10`** |
| 短縮名に対応するセッションが無い | `rc=1` |
| キーボードロック中の書き込み | `rc=5` |
| 位置が範囲外 / 検索で見つからない | `rc=7` |
| 写せないニーモニック | `rc=20` |
| バッファに収まらない | `rc=6`（**切り詰めたことを黙らない**） |

## 受け入れ基準との対応

| requirement の基準 | 満たし方 |
|---|---|
| 中核の機能が動く | 上表の 20 機能 |
| **本物の C ABI で叩いて動く** | Python `ctypes` で `.so` を読み込む（research F8 で実証済みの手法） |
| **実機のセッション**で一連の操作が通る | `scripts/verify-hllapi-*.mjs` から実機セッションを開いて検証 |
| 未実装が規約どおりに断られる | `rc=10` |
| 日本語（DBCS）が壊れない | 境界を UTF-8 に固定。実機の日本語画面で確認 |
| Rust が状態を持たない | Rust に `static` を置かない。**テストで固定** |
| 既存の非退行 | ルート登録 1 行のみ。全テスト |

## 未確定事項（design / plan で決める）

- **Wait / Pause の待ち方**——サーバー側でポーリングするか、既存の画面更新通知に乗るか。
- **`Copy PS` の行連結**に改行を入れるか（HLLAPI の伝統は入れない＝固定長の連結）。
- **DBCS のセル幅**——「1 セル 1 文字」とした影響範囲（既存資産が桁を数えている場合）。

## Windows について（正直に）

**この環境では Windows 版をビルドも検証もできない**（research F9。mingw / MSVC が無い）。

- クレートは **OS 非依存**に書く（`std::net` のみ）。
- **Windows 向けのビルド手順は文書に残すが、動作は主張しない。**
- 実際の利用者は Windows なので、**そこが未検証であることを README と `docs/HLLAPI.md` に明記する**。
