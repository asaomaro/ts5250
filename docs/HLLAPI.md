# HLLAPI / EHLLAPI

既存の HLLAPI 資産（VB / C / Excel VBA など）から **ts5250 の 5250 セッションを駆動する**ための入口。

```
既存資産  ──hllapi(int*,char*,int*,int*)──▶  共有ライブラリ（Rust）
                                                  │ POST /api/hllapi
                                                  ▼
                                            ts5250 サーバー（TypeScript）
                                                  │
                                                  ▼
                                            5250 セッション
```

**ロジックは全部 TypeScript 側にある。** ネイティブの部品（DLL / .so）は
「C ABI ↔ HTTP」だけを担い、機能番号の意味も画面の解釈も持たない。
対応機能を増やしても、**利用者が DLL を差し替える必要は無い**。

## 使い方

### 1. ts5250 サーバーを起動する

```sh
./start.sh          # 既定 http://localhost:3400
```

### 2. 5250 セッションを開く

**HLLAPI の `Connect` はセッションを開かない**（既にある画面に繋ぐだけ）。
先に web-ui / MCP でセッションを開いておくこと。

### 3. 共有ライブラリから呼ぶ

```c
int  func = 1;                 /* Connect Presentation Space */
char data[1920] = "A";         /* 短縮名 */
int  len  = 1;
int  rc   = 0;
hllapi(&func, data, &len, &rc);   /* rc == 0 なら成功 */
```

エントリポイントは 4 つとも同じ実体: `hllapi` / `HLLAPI` / `WinHLLAPI` / `hllc`。

### 接続先と認証

| 環境変数 | 既定 | 用途 |
|---|---|---|
| `TS5250_HLLAPI_URL` | `http://127.0.0.1:3400/api/hllapi` | サーバーの場所 |
| `TS5250_API_TOKEN` | （なし） | 認証が有効なときの API トークン |

**TLS は張らない。** HLLAPI クライアントと ts5250 が同じ機の上にいる前提。
別の機を指す場合は経路の保護を利用者が用意すること。

## WSL で動かして Windows の VBA から使う

開発でよくある形（サーバーは WSL、Excel は Windows）。**そのままでは届かないことがある。**

### 何が起きているか

ts5250 は**認証オフだと `127.0.0.1` にしか張らない**（`bind-host.ts`）。
これは意図した歯止めで、認証が無い状態を LAN へ晒さないためにそうしてある。

```
./start.sh          → 127.0.0.1 に待ち受け（起動時にもそう表示される）
./start.sh --users …→ 0.0.0.0 に待ち受け
```

WSL2 は既定で NAT ＋ localhost 転送。**転送が WSL 内の `127.0.0.1` まで届くかは版による**ので、
まず届くかどうかを実際に見ること。

### まず 5 秒で確かめる（Windows 側で）

```powershell
curl.exe http://localhost:3400/healthz
```

`{"status":"ok",...}` が返れば**そのまま使える**。VBA も既定の
`http://127.0.0.1:3400/api/hllapi` のままでよい。

### 届かないときの直し方（勧める順）

**1. WSL をミラーモードにする**（Windows 11 22H2 以降）。`C:\Users\<名前>\.wslconfig` に:

```ini
[wsl2]
networkingMode=mirrored
```

`wsl --shutdown` して入れ直す。**WSL の `127.0.0.1` が Windows の localhost と同じ**になるので、
ts5250 側は何も変えなくてよい。**これが一番きれい。**

**2. 待ち受けを広げる**——`./start.sh --host 0.0.0.0`。
起動時に警告が出る（認証なしで公開する形なので、**これは正しい警告**）。
NAT モードでは WSL の `0.0.0.0` に届くのは基本 Windows ホストからだが、
**Windows 側で何が開いているかは自分で確かめること**:

```powershell
netstat -ano | findstr :3400
```

**3. WSL の IP を直に指す**——`hostname -I` の値。**WSL を再起動すると変わる**ので、
ブックに書き込む用途には向かない。

### VBA 側

接続先を変えるなら、**最初の `hllapi` 呼び出しより前に**:

```vb
SetServer "http://localhost:3400/api/hllapi"
```

> ⚠ **この経路（Windows → WSL）は検証していない。** 本書の検証はすべて WSL の中で
> 完結している（`127.0.0.1` 同士）。**Windows と WSL をまたぐ部分は未確認**。

## 文字コード — **CP932（Shift-JIS）**

**PS は 1 位置 = 1 バイト。全角は 2 バイトで、画面上でも 2 桁を占める。**
`24×80` の画面はちょうど **1920 バイト**に収まるので、既存資産が確保する
`rows × cols` の器がそのまま使える。

- 読み出し（`Copy PS` 等）は CP932 のバイト列で返る
- 書き込み（`Copy String to Field` 等）も CP932 で渡す
- CP932 に無い文字は `?`（1 バイト）に落ちる。**桁はずらさない**

> UTF-8 ではなく CP932 にしたのは、UTF-8 だと日本語 1 文字が 3 バイトになり、
> **1920 バイトの器に日本語画面が収まらない**ため（実機で確認）。

## 対応している機能

| # | 機能 | 備考 |
|---|---|---|
| 1 | Connect Presentation Space | `data[0]` が短縮名（`A`〜`Z`）。**セッションは開かない**。<br>`"A <指定>"` で狙ったセッションを指せる（下記） |
| 2 | Disconnect Presentation Space | **セッションは閉じない** |
| 3 | Send Key | ニーモニック（下記） |
| 4 | Wait | キーボードのロックが解けるまで。最大 30 秒 |
| 5 | Copy Presentation Space | **改行なしの固定長** |
| 6 | Search Presentation Space | 見つかった位置を `rc` に返す |
| 7 | Query Cursor Location | 位置を `rc` に返す |
| 8 | Copy PS to String | `rc`（入力）または現在のカーソルから |
| 10 | Query Sessions | 短縮名・ホスト・画面サイズ・**指定に使える名前** |
| 11 | Reserve | **自動操作の間、人間の入力を締め出す**（下記） |
| 12 | Release | 予約を外す |
| 15 | Copy String to Presentation Space | 入力欄のみ |
| 18 | Pause | `length` は 1/2 秒単位。最大 30 秒 |
| 20 | Query System | 実装の識別 |
| 22 | Query Session Status | |
| 30 | Search Field | 欄の中だけ |
| 31 | Find Field Position | 位置を `rc` に返す |
| 32 | Find Field Length | 長さを `rc` に返す |
| 33 | Copy String to Field | 欄の先頭から |
| 34 | Copy Field to String | |
| 40 | Set Cursor | |
| 99 | Convert Position or RowCol | `data[1]` が `P` / `R` |

**上記以外はすべて `rc=10`（`HRC_FUNCTION_UNAVAILABLE`）で断る。** 黙って成功にしない。

未対応の主なもの: Set Session Parameters (9)、Copy OIA (13)、
Query Field Attribute (14)、キーストローク傍受 (50〜53)、ファイル転送 (90/91)。

## どのシステムのどのセッションかを指定する

標準の `Connect` は短縮名 1 文字しか渡さないので、**開いた順**でしか指せない。
自動化にとってこれは危うい——順番が変われば別のシステムの本番画面を操作しうる。

そこで `Connect` のバッファに**続けて指定を書ける**ようにしてある（ts5250 の拡張）。

```vb
f = 1: d = "A 検証" & Space$(120): l = 128    ' セッション名で指す
Call hllapi(f, d, l, r)
```

指定に書けるもの（**大文字小文字は無視**、最初の NUL までを読む）:

| 書き方 | 例 |
|---|---|
| セッション設定の**名前** | `検証` |
| 設定の参照 | `srv:s-kensho` |
| `<システム参照>/<名前>` | `srv:as400/検証` （名前が重なるとき） |
| 実行中のセッション id | `3f9c…` |

- **当たらなければ繋がない**（`rc=1`）。黙って別のセッションへ繋がない
- **同じ名前が 2 つ開いていたら断る**（`rc=11`）
- **指定を省けば従来どおり**（`"A"` だけ）——既存の資産はそのまま動く

指定に書ける名前は **`Query Sessions` (10) が出す**（4 列目）:

```
A 10.0.0.5 24x80 検証
```

> `Connect` は**セッションを開かない**（HLLAPI の仕様）。先に web-ui / MCP で開いておくこと。

### 指定を書かないとき（`Connect("A")`）

| 動いているセッション | `A` | `B` |
|---|---|---|
| 1 台 | **その 1 台** | その 1 台（**空きへ寄せる**）／A が押さえていれば `rc=1` |
| 他人のもの | **`rc=1`**（名指しでのみ届く） | 同左 |
| 2 台 | 古いほう | 新しいほう |
| 0 台 | `rc=1` | `rc=1` |

古い順（`connectedAt`）に `A`、`B`… と割り当て、その席が埋まっていれば**空いている
いちばん古いもの**へ寄せる。**空きが無ければ `rc=1`**（同じセッションを 2 つの短縮名に
割り当てない）。同じ短縮名をもう一度繋いでも対応は変わらない。

> 本来の HLLAPI では短縮名はエミュレーター側の設定で決まる（`B` は「B として構成された
> セッション」）。ts5250 には事前設定が無いので**空きへ寄せる**ほうを採った。
> 狙ったセッションを確実に掴みたいなら、指定を書くこと。

## 管理者は他人のセッションも操作できる

**これは HLLAPI に限らず、いまの ts5250 全体の性質**（`assertOwner` は admin を通し、
`SessionManager.list` も admin には全件返す）。MCP・WebSocket・HLLAPI のどれでも同じ。

支援や障害対応には有用だが、**既定が危うい**ことは知っておくこと:

- **指定を書かない `Connect("A")` は、自分のセッションだけを見る。**
  管理者でも他人の画面は掴まない（無ければ `rc=1`）。**越権は名指しのときだけ**
  ——`Connect("A", "<セッション名>")`。支援の用途は塞がないが、**既定にはしない**
- **他人のセッションを予約すると、触られた側に操作者の名前が出る**
  ——「**kanri（HLLAPI）が自動操作中です**」。自分のセッションなら仕組みの名前だけ
  （自分の操作に自分の名前を出しても情報が無い）
- **操作は監査に残る**（`hllapi_<機能番号>`）。**自分以外のセッションを触ったときは
  対象の所有者も載る**ので、後から追える

> バッファの中身は監査にも載せない（サインオン画面への入力が通るため）。

## 排他 — `Reserve` / `Release`

**同じセッションをブラウザと自動化が同時に触る**のがこの実装の前提。
5250 セッションの実体はサーバーにあり、ブラウザはそれを見ている view にすぎない
（HLLAPI は 2 人目のクライアント）。

5250 は**入力欄の値を AID と一緒に送る**ので、ブラウザは Enter を押すまで打ちかけを
手元に持っている。その最中に自動化が画面を変えると、打ちかけの行き先が消える。
自動操作の前後を `Reserve` / `Release` で囲むこと。

```vb
f = 11: Call hllapi(f, d, l, r)   ' Reserve — 以降、人間は打てない
' ... 自動操作 ...
f = 12: Call hllapi(f, d, l, r)   ' Release
```

- 予約中、**ブラウザと MCP からの書き込みは断られる**（HTTP なら 409 / `SESSION_RESERVED`）。
  画面には「HLLAPI が自動操作中です」と出る
- 既に**別の使い手**が予約していれば `rc=11`
- **`Disconnect` (2) でも外れる**（正常終了したのに締め切ったままにしない）
- **2 分で自動的に切れる**。呼び出しのたびに延びる。
  接続層は状態を持たない＝**落ちた自動化は `Release` を送れない**ので、期限が要る
- それでも詰まったら、**画面の「解除して操作する」で利用者が取り戻せる**

> **MCP も同じ扱い**（予約中は締め出される）。ただし **MCP には予約する手段がまだ無い**
> ——`.aidev/backlog/session-exclusion.md`。

## キーのニーモニック

`@` を接頭辞にする。**普通の文字はそのまま入力**（`"ABC@E"` = ABC を打って Enter）。

| | | | |
|---|---|---|---|
| `@E` Enter | `@C` Clear | `@P` Print | `@@` 文字の `@` |
| `@1`〜`@9` F1〜F9 | `@a`〜`@o` F10〜F24 | `@A@H` SysReq | `@A@Q` Attn |
| `@T` Tab | `@B` BackTab | `@0` Home | `@U/@V/@L/@Z` カーソル |

### 写せないキーは `rc=20`

ニーモニックの表は **3270 由来**で、`PA1`〜`PA3`（`@x`/`@y`/`@z`）のように
**5250 に無いキー**が含まれる。これらは `HRC_UNDEFINED_COMBINATION`(20) で断る。

**写せないキーが 1 つでも混ざっていたら、何も送らずに断る**——
一部だけ送ると画面が半端な状態で残り、呼び出し側から復旧できないため。

### 画面を書き換えるローカル操作は未対応

`@F`（Erase EOF）・`@D`（Delete）・`@<`（Back Erase）・`@N`（New Line）・`@R`（Reset）は
**カーソル位置を動かすだけ**で、画面の書き換えは行わない。
消したいときは `Copy String to Field` で空白を書くこと。

## 戻り値

| コード | 意味 |
|---|---|
| 0 | 成功 |
| 1 | 短縮名に対応するセッションが無い |
| 2 | パラメータの誤り（ヌルポインタ・不正な短縮名） |
| 4 | ビジー（Wait が時間切れ） |
| 5 | 書けない（保護欄・欄の外・キーボードロック・**読み取り専用のセッション**） |
| 6 | 切り詰めた（バッファに収まらない） |
| 7 | 位置が無効／**検索で見つからない** |
| 8 | 呼ぶ順序が違う（接続していない） |
| 9 | システムエラー（**サーバーへ届かない**） |
| 10 | **未対応の機能** |
| 11 | 他の使い手が予約している（`Reserve`） |
| 20 | 写せないキー |
| 26 | Pause の途中で画面が変わった |
| 28 | 欄の長さが 0 |

## ビルド

```sh
./crates/hllapi/tools/build.sh              # そのホスト向け（.so / .dylib）
./crates/hllapi/tools/build.sh --windows    # Windows 版 64bit ＋ 32bit も
```

Windows 上で MSVC ツールチェーンを使う場合:

```powershell
pwsh -File crates\hllapi\tools\build.ps1 -Arch both -Install C:\ts5250
```

**外部クレートを使っていない**ので、レジストリへ取りに行かずにビルドできる。

| 出力 | 使いどころ |
|---|---|
| `target/release/libts5250hllapi.so` | Linux |
| `target/x86_64-pc-windows-gnu/release/ts5250hllapi.dll` | **64bit Office** |
| `target/i686-pc-windows-gnu/release/ts5250hllapi.dll` | **32bit Office** |

### スクリプトが面倒を見ること

- **C コンパイラが無い環境**では `cc` をリンカに使えないので `rust-lld` へ切り替える
- **Windows 版に要る mingw の import ライブラリを、root 無しで取ってくる**
  （`apt-get download` ＋ `dpkg -x`。既に入っていればそれを使う。`MINGW_ROOT` でも指定可）
- `rustup target add` を必要に応じて実行する
- **リポジトリには何も焼き込まない**（`.cargo/config.toml` を置かない）。
  必要なものは実行時に環境変数で渡す

### 出来たものを必ず検査する

```sh
python3 crates/hllapi/tools/check-dll.py <dll または so>
```

**ビルドが通ったことは正しさの保証にならない。** 見ているのは 2 つ:

1. **4 つのエントリが装飾なしの名前で出ているか。**
   32bit の `stdcall` は普通 `_hllapi@16` に装飾される。VBA の `Declare` は
   装飾なしの名前を引くので、装飾されていると「関数が見つかりません」になる
2. **32bit 版が本当に `stdcall` か。** `extern "C"`（cdecl）のままだと VBA から
   呼んだ瞬間にスタックが壊れる。**名前からは判別できない**ので機械語の `ret` を見る
   （`ret 0x10` = 4 引数を呼ばれた側が片付ける = `stdcall`）

`build.sh` / `build.ps1` はビルドの後で自動的にこれを走らせる。

### 呼び出し規約

エクスポートは **`extern "system"`**——32bit Windows では `stdcall`、それ以外では `C`。
WinHLLAPI と VB / VBA の `Declare` は既定が `stdcall` なので、`extern "C"`（cdecl）だと
**32bit Office からの呼び出しでスタックが壊れる**。64bit では規約が 1 つしかないので違いは出ない。

**Office と DLL のビット数は合わせること。** 合っていないと
「指定されたモジュールが見つかりません」になる（パスの問題ではない）。

### 検証済みのこと / まだのこと

| | 状態 |
|---|---|
| Linux 版のビルドと実動作 | ✅ 実機 33/33 ＋ E2E 18/18 |
| **Windows 版（64/32bit）のビルド** | ✅ `tools/build.sh --windows` で生成 |
| **エクスポート名と呼び出し規約** | ✅ `tools/check-dll.py` で検査 |
| **Windows 上での実行** | ❌ **未検証**（この開発環境に Windows が無い） |
| **VBA の `Declare` 経由の呼び出し** | ❌ **未検証** |

## 他の HLLAPI 実装と比べる

同じ VBA を **PCOMM / 旧 iSeries Access** に対しても動かせる（`Declare` の `Lib` を
変えるだけ）。**ACS 本体（Java 版）は HLLAPI を持たない**——追加で入れるものがあるとすれば
「IBM i Access Client Solutions - Windows Application Package」だが、
そこに含まれるかどうかは版による。

**記憶や伝聞で決めずに、実際に調べること:**

```powershell
pwsh -File crates\hllapi\tools\find-hllapi.ps1
```

IBM 系のフォルダを走査し、**DLL のエクスポートを実際に読んで** HLLAPI のエントリを
持つものを挙げる（名前とビット数も出る）。VBA の `Declare` に書く DLL 名はこれで決まる。

> ⚠ **`Connect` の第 2 引数（セッション指定）は ts5250 独自。** 他の実装へ投げると
> 短縮名として解釈されず失敗する。両方で動かすなら `Connect("A")` と書くこと。

## Excel / VBA から使う

- `docs/hllapi-sample.bas` — VBE の「ファイル」→「ファイルのインポート」で読み込む。
  `Connect` / `Reserve` / `CopyScreen` などのラッパと、動く例が 4 つ入っている
- `crates/hllapi/tools/make-xlsm.ps1` — 上記を組み込んだ `.xlsm` を **Windows 上の Excel に作らせる**
  （`.xlsm` の VBA プロジェクトは OLE 複合ファイルなので Linux 側では組めない）

```powershell
pwsh -File crates\hllapi\tools\make-xlsm.ps1 -DllPath C:\ts5250\ts5250hllapi.dll
```

**文字コードの変換は書かなくてよい。** VBA の `Declare` は `ByVal ... As String` を
ANSI（日本語 Windows では CP932）へ自動変換して渡し、戻りで書き戻す。
DLL 側も CP932 なので、`Space$(1920)` の器がそのまま画面 1 枚になる。

```vb
Dim s As String
s = CopyScreen()                 ' 1920 バイト
MsgBox ScreenLine(s, 1)          ' 1 行目（Mid で切れる）
```

> ⚠ **VBA からの実行は確かめていない**（この開発環境に Windows と Excel が無い）。
> C ABI としては Python の `ctypes` で 33 件通り、DLL の呼び出し規約も機械語で
> 確かめてあるが、**VBA の `Declare` を通した動作そのものは未検証**。

### `cargo test` が動かない環境

C コンパイラが無いとテスト実行ファイルをリンクできない（`crt1.o` が無い）。
`selftest` フィーチャで検査を共有ライブラリから走らせられる
——**中身は `cargo test` と同じ関数**（`src/selftest.rs`）なので二重に書いていない。
`tools/build.sh` はネイティブ版にこのフィーチャを付けてビルドする。

## 検証

| スクリプト | 見るもの | 結果 |
|---|---|---|
| `crates/hllapi/tools/check-dll.py` | エクスポート名・**呼び出し規約**（機械語） | 3 種すべて OK |
| `scripts/verify-hllapi.mjs` | **本物の C ABI** ↔ 実機セッション | 33/33 |
| `scripts/verify-hllapi-browser.mjs` | **DLL → 実機 → 実物のブラウザ**（Playwright） | 18/18 |

```sh
python3 crates/hllapi/tools/check-dll.py crates/hllapi/target/*/release/*.dll
node --env-file=.env scripts/verify-hllapi.mjs
node --env-file=.env scripts/verify-hllapi-browser.mjs
```

`ctypes` を挟むのは、**C ABI をそのまま叩く**ため。TypeScript から HTTP を叩くだけでは
C ABI の引数の受け渡しを確かめたことにならない。

## 設計の要点

- **1 呼び出し = HTTP 1 往復。** ネイティブ側に状態も相関も持たせない。
  短縮名の対応表も論理カーソルも TypeScript 側が持つ。
- **バイト列は base64 で運ぶ。** JSON はテキストしか運べないので、
  CP932 のバイト列をそのまま通すために挟む。ネイティブ側は符号を解くだけで、中身を解釈しない。
- この「薄さ」は `packages/server/test/hllapi-bridge-thinness.test.ts` が
  **Rust のソースを走査して固定**している
  （機能名・機能番号での分岐・可変の状態・外部依存が無いこと）。
  **`cargo test` 側に置いていない**のは、この環境では C コンパイラが無くテスト実行ファイルを
  リンクできず、標準の検査（`npm test`）でも走らないため——**走らない検査は無いのと同じ**。
