# 調査: FFW の ADJUST とローカル編集キー

requirement の「未確定」を潰すための調査。**原典の直読**（GNU tn5250 の C 実装と tn5250j の
Java 実装）と、**実機の実測**の 2 本立てで行う（AGENTS.md「既存プロトコル実装の移植」）。

## 1. 原典（参照実装のソースを直読）

取得元（作業ディレクトリへ取得しただけ。リポジトリには取り込まない）:

- GNU tn5250 `lib5250/field.h` / `field.c` / `display.c` / `terminal.h`
  （<https://raw.githubusercontent.com/tn5250/tn5250/master/lib5250/>）
- tn5250j `src/org/tn5250j/framework/tn5250/Screen5250.java`
  （<https://raw.githubusercontent.com/tn5250j/tn5250j/master/>）

### 1.1 ADJUST の値と意味（両実装が一致）

`field.h` の定義は `packages/core/src/protocol/constants.ts` の値と**完全に一致**していた。

| 値 | tn5250 名 | 意味 |
|---|---|---|
| `0x0000` | `NO_ADJUST` | 指定なし |
| `0x0001`–`0x0004` | `MF_RESERVED_1`–`4` | 予約（未使用） |
| `0x0005` | `RIGHT_ZERO` | 右寄せ・**ゼロ埋め** |
| `0x0006` | `RIGHT_BLANK` | 右寄せ・**空白埋め** |
| `0x0007` | `MANDATORY_FILL` | 必須充填 |

### 1.2 「右寄せ」の正確なアルゴリズム（`tn5250_display_shift_right`）

`display.c:1085-1119`。**これが実装の基準**。

```c
ptr = field_data; end = length - 1;
if (signed_num) end--;                      /* 符号桁は動かさない */
for (n = 0; n <= end && (ptr[n]==0 || ptr[n]==0x40); n++) ptr[n] = fill;  /* 先頭の空白を fill で埋める */
if (n > end) return;                        /* 全部空白なら何もしない（無限ループ防止） */
while (ptr[end]==0 || ptr[end]==0x40) {     /* 末尾が空白の間、右へ 1 桁ずつずらす */
    for (n = end; n > 0; n--) ptr[n] = ptr[n-1];
    ptr[0] = fill;
}
```

読み取れる仕様（推測ではなくコードそのもの）:

- **末尾が既に非空白なら 1 桁も動かさない**（満杯の欄は無変化）
- **全桁が空白の欄は無変化**（`fill` で埋め尽くさない）。これは明示的に「そうしないと無限ループ」と
  コメントされている
- **語中の空白は保持されたまま一緒に右へ動く**（`1 2␣␣␣␣` → RZ → `0001 2`）
- 先頭の空白は**先に `fill` へ置換**され、そのうえで右詰めされる

### 1.3 ADJUST が適用される契機（重要・非自明）

`tn5250_display_field_adjust` の呼び出し元を全部数えた（`display.c` 内 3 か所）:

| 行 | 契機 |
|---|---|
| `:1041` | 打鍵で**欄が満杯になり自動送りする**とき（ただし FER 欄は除く） |
| `:1609` | `field_pad_and_adjust` 経由 = **Field Exit / Field+ / Field−** |
| `:1821` | **DUP キー** |

**`K_TAB`（`:1428`）と `K_ENTER`（`:1436`）は adjust を通らない。** つまり
**Tab や Enter で欄を出ても右寄せされない**——右寄せしたいなら Field Exit を押す、という
のが 5250 の作法。これは「Field Exit を実装しないと ADJUST が意味を持たない」ことの裏付けで、
本 work が 2 件を 1 つにまとめた判断（requirement）と整合する。

### 1.4 `MANDATORY_FILL`（0x0007）は右寄せではない

両実装とも**桁をずらさない**。

- tn5250 C（`display.c:1143-1155`）: `NO_ADJUST` と同じ `break`（何もしない）
- tn5250j（`Screen5250.java:1596`）: `sf.setManditoryEntered()` を呼ぶだけ

→ 「全桁を埋めよ」という**入力検証**の指定であって、右寄せ処理ではない。
本 work では**桁をずらさない**（検証は別 work）。

### 1.5 符号付き数値（`SHIFT_SIGNED_NUMERIC 0x0700`）は ADJUST 指定が無くても右寄せされる

- tn5250 C（`display.c:1138-1141`）: `mand_fill_type` を**無条件に `RIGHT_BLANK` へ差し替える**。
  コメントは "Because of special processing during transmit and other weirdness"
- tn5250j（`Screen5250.java:1601-1607`）: `adj == 0` かつ `isSignedNumeric()` なら `rightAdjustField(' ')`

どちらも**最終桁（符号桁）は動かさない**（C は `end--`、Java は `count--`）。

→ requirement では「符号付き数値の送信表現」を対象外にしたが、**この右寄せ自体は adjust 機能の一部**。
実機で確かめてから採否を決める（下の 2.3）。

### 1.6 Field Exit の中身（tn5250j `fieldExit()` / tn5250 `field_pad_and_adjust`）

1. `MANDATORY_ENTER` 欄が空なら**エラーで中断**（tn5250j のみ。C は未実装）
2. **カーソル位置から欄末尾までを消去**（符号付き数値は符号桁を残す）
3. **ADJUST を適用**
4. 呼び出し側が **MDT を立てて次の入力欄へ**（`AUTO_ENTER` 欄なら代わりに Enter を送る）

### 1.7 Erase EOF / Erase Input は**どちらの参照実装にも無い**

「あると思い込んで設計しない」（AGENTS.md）ため、無いことも事実として記録する。

- GNU tn5250: `terminal.h:95` に `K_ERASE` の**定義はあるが、lib5250 のどこからも参照されていない**
  （`field.c` / `display.c` / `session.c` / `dbuffer.c` を grep して 0 件）
- tn5250j: `ERASE_EOF`(1010) と `ERASE_FIELD`(1011) はあるが、**Erase Input に相当するものは無い**
  （`TN5250jConstants.java` の mnemonic 一覧に存在しない）

tn5250j の `ERASE_EOF` は `fieldExit()` をそのまま呼び、**右寄せまで走らせてからカーソルを元へ戻す**
（`Screen5250.java:951-979`）。ただし本 PJ の backlog は Erase EOF を
**「Field Exit の①だけ」**（＝消去のみ・右寄せしない）と定義しているので、**backlog の定義を採る**。
tn5250j 側は `fieldExit()` の使い回しによる副作用と読める（消去しただけで値が右へ飛ぶのは不自然）。

→ **Erase Input は参照実装が無いので、backlog の定義「全入力欄をクリア」で実装する。**

## 2. 実機（TESTLIB）

### 2.1 フィクスチャ

`scripts/build-adjtest.mjs` で `TESTLIB/ADJDSPF` + `TESTLIB/ADJPGM` を作成（冪等）。
1 レコードに次の入力欄を並べ、`exfmt` の後に受信値を `[...]` で囲んで出力欄へ写す
（**前後の空白が画面から読める**）。

| 欄 | DDS | 狙い |
|---|---|---|
| `ARZ` | `6A B CHECK(RZ)` | 右寄せゼロ埋め |
| `ARB` | `6A B CHECK(RB)` | 右寄せ空白埋め |
| `AMF` | `6A B CHECK(MF)` | 必須充填 |
| `AFE` | `6A B CHECK(FE)` | Field Exit 必須 |
| `AME` | `6A B CHECK(ME)` | 必須入力 |
| `APLN` | `6A B` | 素の英数字欄（対照） |
| `NRZ` | `6 0 B CHECK(RZ)` | 数値欄＋右寄せ |
| `NPLN` | `6 0 B` | 素のゾーン数値欄（対照） |
| `SPLN` | `6S 0 B` | 符号付き数値欄（1.5 の検証） |

**`CHECK(RZ)/(RB)/(MF)/(FE)/(ME)` はいずれも英数字欄（`A`）で CRTDSPF が通った**
（`ライブラリー TESTLIB にファイル ADJDSPF が作成された。`）。数値欄限定ではない。

### 2.2 FFW の実測

`scripts/research-adjust.mjs` が生データストリームを捕まえ、**core を通さず独立に**
SF オーダーを歩いて FFW を取り出す（検証対象の実装に依存させないため）。

```
in# 1 len=  6 FFW=0x4025  shift=alpha      adjust=right-zero      MONOCASE          ← CHECK(RZ) A
in# 2 len=  6 FFW=0x4026  shift=alpha      adjust=right-blank     MONOCASE          ← CHECK(RB) A
in# 3 len=  6 FFW=0x4027  shift=alpha      adjust=mandatory-fill  MONOCASE          ← CHECK(MF) A
in# 4 len=  6 FFW=0x4060  shift=alpha      adjust=none  FER       MONOCASE          ← CHECK(FE) A
in# 5 len=  6 FFW=0x4028  shift=alpha      adjust=none  MONOCASE MANDATORY_ENTER    ← CHECK(ME) A
in# 6 len=  6 FFW=0x4020  shift=alpha      adjust=none  MONOCASE                    ← 素の A
in# 7 len=  7 FFW=0x4705  shift=signed-num adjust=right-zero                        ← CHECK(RZ) 6 0
in# 8 len=  7 FFW=0x4700  shift=signed-num adjust=none                              ← 素の 6 0
in# 9 len=  7 FFW=0x4700  shift=signed-num adjust=none                              ← 6S 0
```

分かったこと:

- **DDS の `CHECK(RZ)/(RB)/(MF)/(FE)/(ME)` は期待どおり FFW のビットへ載る**。
  値も 1.1 の表（`constants.ts` の定義）と一致した。**定義は正しい。使っていないだけ**だった
- **英数字欄には既定で `MONOCASE` が立つ**（`CHECK(LC)` を書いていないため）。backlog の
  「US 系 CCSID の MONOCASE 欄では小文字がそのまま通る」は、**ごく普通の DDS で常に起きる**
  ことを意味する（本 work の対象外だが、影響範囲の見積もりとして記録する）
- **DDS の数値入力欄は `6 0`（ゾーン）も `6S 0`（符号付き）も、ワイヤ上は
  `shift=signed-num`・長さ = 桁数 + 1**（最終桁が符号桁）になる。
  つまり **1.5 の「符号付き数値は ADJUST 指定が無くても右寄せ」は、この機の全数値欄に効く規則**

### 2.2.1 参考: 素の英数字欄が MONOCASE になる件

本 work では扱わないが、`.aidev/backlog/field-input.md` の MONOCASE 項目は
「特殊な DDS でだけ起きる」ものではないと分かったので、backlog 側に追記する。

### 2.3 符号付き数値の扱い（1.5 の判断材料）

`scripts/research-adjust-roundtrip.mjs` で、同じ値を **(A) 左詰めのまま**（＝右寄せ未実装の
現状）と **(B) 右寄せしてから**送り、RPG が受け取った値を突き合わせた。

| 欄 | (A) 送信 → ホスト受信 | (B) 送信 → ホスト受信 |
|---|---|---|
| `ARZ` CHECK(RZ) A | `"12"` → `"12    "` | `"000012"` → `"000012"` |
| `ARB` CHECK(RB) A | `"12"` → `"12    "` | `"    12"` → `"    12"` |
| `AMF` / `AFE` / `AME` / `APLN` A | `"12"` → `"12    "` | （同左） |
| `NRZ` CHECK(RZ) 6 0 | `"12"` → `12` | `"000012"` → `12` |
| `NPLN` 6 0 | `"12"` → `12` | `"000012"` → `12` |
| `SPLN` 6S 0 | `"12"` → `12` | `"000012"` → `12` |

**結論 2 つ（どちらも実測。推測ではない）:**

1. **英数字欄はホストが一切整形しない。** 送った通りの桁位置でそのまま格納される。
   → **右寄せは端末がやらなければ永久に行われない**＝ backlog の「送信値も変わる」は
   **英数字欄について正しい**。CHECK(RZ)/CHECK(RB) を書いた DDS は現状ぜんぶ左詰めで届いている
2. **数値欄はホスト側が吸収する。** 左詰めで送っても `12` と解釈された（`120000` にはならない）。
   → 数値欄の右寄せは**送信値の正しさのためではなく、画面表示を実機と合わせるため**の機能。
   backlog の「数値欄で実機と見た目も送信値も変わる」のうち、**送信値が変わるのは英数字欄**で、
   数値欄は**見た目だけ**だった（この切り分けは実測しないと出てこない）

→ **1.5（符号付き数値は ADJUST 指定が無くても空白で右寄せ）は採用する。**
   実機の数値欄はすべて `shift=signed-num` なので、採らないと Field Exit が数値欄で何もしない。
   ホストは左詰めも右詰めも同じに解釈するので**採用による退行リスクが無い**ことが実測で分かった。

**ただし副作用が 1 つある**: 空白埋めの右寄せは値に先頭空白を作るが、
`packages/core/src/screen/field-validate.ts:19` の数値欄許容集合 `/^[0-9.,+-]*$/` は
**空白を弾く**。そのままだと自分の検証で送信できない。→ spec で扱う。

## 3. 設計上の結論（spec へ渡す）

requirement の「未確定」に対する答え。

| 未確定だったこと | 結論 | 根拠 |
|---|---|---|
| ADJUST の適用契機 | **Field Exit / Field+ / Field− / DUP / 打鍵で満杯になったとき**のみ。**Tab・Enter では適用しない** | 1.3（呼び出し元を全数確認） |
| ADJUST の適用主体 | **端末（web-ui）**。ホストは整形しない | 2.3 の実測 1 |
| `MANDATORY_FILL 0x0007` | 右寄せ**ではない**（桁を動かさない）。充填の検証指定 | 1.4（両実装とも no-op） |
| 実機が ADJUST ビットを立てるか | **立てる**。`CHECK(RZ)/(RB)/(MF)` がそのまま載る | 2.2 |
| 既定キーバインドを付けるか | **付ける**。ただし「版ごとに増分だけ混ぜる」方式に直す（後述） | — |

### 3.1 実装の置き場所

- **core**: スナップショットの `Field` に ADJUST 種別を公開する（現状 `numeric` しか出ていない）。
  web-ui はここを見て右寄せする。**core は右寄せしない**（端末の仕事なので web-ui に置く。
  core が送信時に整形すると、画面には左詰めのまま出て実機と見た目が食い違う）
- **web-ui**: 純ロジックは `composables/fieldEdit.ts` に置いて単体テストする
  （`rightAdjust` / `eraseToEnd` / `fieldExit`）。`ScreenGrid.vue` は編集モデルの持ち主なので、
  キー操作の入口とフォーカス移動だけを担当する

### 3.2 Erase EOF は右寄せしない（tn5250j と意図的に違える）

tn5250j は `ERASE_EOF` でも `fieldExit()` を呼ぶため右寄せまで走る（1.7）。
本 PJ の backlog は Erase EOF を「Field Exit の①だけ」と定義しており、
**消しただけで残った文字が右へ飛ぶのは操作として不自然**なので backlog の定義を採る。
`decisions.md` に逸脱として記録する。

### 3.3 既定キーバインドの混ぜ込みに既存バグがある

`packages/web-ui/src/stores/keybindings.ts` の `load()` は版を上げると
`{ ...DEFAULT_BINDINGS, ...saved }` で**全既定を混ぜ直す**。既定を追加するために版を上げると、
**利用者が消した既存の既定まで復活する**（同ファイルの「消したら消えたまま」というコメントに反する）。
既定を足す本 work では、**版ごとの増分だけを混ぜる**方式へ直してから足す。
