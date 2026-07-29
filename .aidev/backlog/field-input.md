# フィールド入力仕様（FFW 挙動ビット・ローカル編集キー）

2026-07-28 に「EDTWRD / EDTMSK に対応できているか」を調べた際、**FFW の挙動ビットが
ほぼ未実装**だと分かった。EDTWRD / EDTMSK 自体は追加実装不要と結論が出ているので、
その根拠（再調査しないため）と、そこで見つかった残件をここへ積む。

同じ調査の続きで **Field Exit 等のローカル編集キーも未実装**だと分かった。
こちらは **README が対応済みと書いている**ぶん厄介なので、あわせて積む。

## 調査済み: EDTWRD / EDTMSK は追加実装が要らない

**再調査しないこと。** 2026-07-28 に実データストリームで検証済み（結論と根拠は以下）。

- **EDTWRD（編集語）はホスト側の整形**。DDS のコンパイル時キーワードで、表示ファイルが
  数値を整形した**ただの文字列**をデータストリームに載せて送る。端末に編集ロジックは無い。
  リポジトリ内に `EDTWRD` / `EDTCDE` の出現が 0 件なのは正しい状態。
  - 検証: `1,234,567.89` / 末尾マイナス / ` CR` / `$***1,234.56` / 先頭空白 / `12/31/26` /
    `123-45-6789` がそのまま表示できることを確認
  - **CCSID 5026 / 930 で `¥` を含む編集語も可逆**（`substituted=0`）。0x5B が `$`/`¥` に
    分岐する箇所なので、ここが通るかは毎回の関心事になりやすい
- **EDTMSK（編集マスク）もワイヤ上に存在しない**。SF オーダーは
  `[FFW(2)] [FCW(2)*] attr(1) length(2)`（`packages/core/src/protocol/wtd-applier.ts:400`）で、
  フィールドは**連続 1 区間**・FCW は**固定 2 バイト**。よって「N 桁ぶんのマスク」は
  **構造的に表現できない**。ホストは EDTMSK 欄を
  **複数の入力欄＋その間の保護された編集文字**へ分解して送るほかない。
  - 検証: SSN `123-45-6789` 相当（3 桁欄 `-` 2 桁欄 `-` 4 桁欄）を流し、3 つの数値欄として
    正しい桁に載り、`-` が欄の外の画面文字になることを確認
  - EDTMSK の肝である「カーソルが編集文字をスキップする」挙動は、**欄が満杯なら次欄へ
    自動送り**する既存実装で成立している（`packages/web-ui/test/pane-nav.test.ts` ・
    `field-full-advance.test.ts` が担保）

## 未実装: FFW の挙動ビット（定義だけあって参照ゼロ）

`packages/core/src/protocol/constants.ts:133-158` に定義はあるが、実際に使われているのは
**`BYPASS` / `MDT` / `SHIFT_MASK` / `SHIFT_NUMERIC_ONLY` / `SHIFT_DIGITS_ONLY` /
`SHIFT_SIGNED_NUMERIC` の 6 つだけ**（全ソースの `FFW.*` 参照を数えて確認）。
以下は**一度も参照されていない**。

- [x] ~~**ADJUST（右寄せ）** `ADJUST_MASK 0x0007` / `RIGHT_ZERO 0x0005` /
      `RIGHT_BLANK 0x0006` / `MANDATORY_FILL 0x0007`~~
  - **対応済み**（`.aidev/works/20260729-field-adjust-local-edit-keys`）。Field Exit と一体で実装した
  - 実測で分かった訂正: **送信値が変わるのは英数字欄**（`CHECK(RZ)/(RB)`）で、
    **数値欄はホスト側が吸収する**（左詰めで送っても正しく解釈される＝見た目だけの違い）。
    「数値欄で送信値も変わる」という当初の見立ては誤りだった
  - `MANDATORY_FILL` は右寄せではなく充填の**検証**指定（参照実装 2 つとも桁を動かさない）。
    検証そのものは未実装＝下の「未実装」に残す
- [x] ~~**MANDATORY_FILL の入力検証** `0x0007`~~
- [x] ~~**FIELD_EXIT_REQUIRED** `0x0040`~~
- [x] ~~**AUTO_ENTER** `0x0080`~~
- [x] ~~**MONOCASE** `0x0020`~~
- [x] ~~**MANDATORY_ENTER** `0x0008`~~
- [x] ~~**SHIFT の未強制分** `ALPHA_ONLY 0x0100` / `KATAKANA 0x0400` / `IO 0x0600`~~
  - **対応済み**（`.aidev/works/20260729-ffw-behavior-bits`）。実機で FFW の実バイトを
    採ってから実装した。実測で分かった要点:
    - **MONOCASE は既定で立つ**。DDS の文字欄は `CHECK(LC)` を書かない限り載る
      （素の `6A` → `0x4020` / `CHECK(LC)` 付き → `0x4000`）
    - **`CHECK(ER)` が AUTO_ENTER（0x0080）を立てる DDS キーワード**
    - **ホストは `CHECK(ME)` / `CHECK(MF)` を検証しない**（空・部分入力のまま Enter が素通りする）
      ＝端末が止めなければ誰も止めない
    - **`KATAKANA 0x0400` は入力制限ではない**（キーボードのシフト状態）。参照実装 2 つとも素通し。
      **制限として実装しないこと**。`IO 0x0600` は逆に「キーボードから入力不可」
    - 必須検証は **Enter のときだけ**（機能キーで止めると必須欄が空の画面から F3 で抜けられない）
- [x] ~~**DUP_ENABLE** `0x1000`~~
  - **対応済み**（`.aidev/works/20260729-field-sign-dup-keys`）。Dup キーと一体で実装した。
    **DDS の `DUP` キーワード**が立てる（実測 `0x5020`）。複写文字は `0x1C`

## 未実装: ローカル編集キー（Field Exit / Erase EOF / Erase Input）

**【2026-07-29 追記】この節は 3 つとも実装済み**（`useKeymap.ts` の `LOCAL_EDIT_ACTIONS`、
`keybindings.ts` の既定バインド `ctrl+Enter` / `ctrl+Delete` / `ctrl+Backspace`）。
README との食い違いも解消している。**未実装で残るのは Field− / Field+ だけ。**
以下は起票当時の記述（経緯として残す）。

~~README:335 は「ローカル編集キー（Field Exit / Erase EOF / Erase Input）、キーバインドは
編集可能」と書いているが、3 つとも実装が無い。~~ ロードマップではなく
`## 🖥 Web エミュレーターの使い方` → `2. **操作**` 配下の**機能一覧**に書かれているため、
実装するか README を直すかのどちらかが要る（2026-07-28 時点で食い違ったまま）。

これらは **AID キーではなくローカル操作**（ホストへ送らず端末が完結させる）なので、
`AidKey` ではなく `LocalAction` 側に足すもの。現状の欠落は以下。

- 実装は 0 件。`packages/web-ui/src/composables/fieldEdit.ts:41` に
  「`cursor===len` は満杯で以降の入力はブロックされる（**field-exit 必要**）」という
  コメントがあり、必要性は認識されているが実行する手段が無い
- `packages/web-ui/src/composables/useKeymap.ts:4-16` の `LocalAction` は
  `home` / `end` / `tab` / `shift-tab` / 矢印 / `word-*` のみ
- `packages/web-ui/src/stores/keybindings.ts:23` の
  `BindingTarget = AidKey | view:${string} | macro:${string}` に**ローカル編集キーの枠が無い**
  ＝「キーバインドは編集可能」を満たすには **`BindingTarget` の拡張も要る**
- 画面下部のキー行（`StatusBar.vue`）は F1–F24 と Attn / SysReq のみ。
  既定バインドは `ctrl+F1`（カナ）/ `ctrl+F3`（SO/SI）の 2 つだけ

- [x] ~~**Field Exit**~~
  - **対応済み**（`.aidev/works/20260729-field-adjust-local-edit-keys`）。ADJUST と一体で実装した
- [x] ~~**Field− / Field+**~~
  - **対応済み**（`.aidev/works/20260729-field-sign-dup-keys`）。「符号付き数値の送信表現」と
    一体で実装した。数値欄で `-` / `+` を打つと**文字として入らず Field− / Field+ が走る**
  - **num-only 欄の符号処理は対象外**（実機の数値入力欄はすべて signed-num で確かめられないため。
    Field Exit と同じ振る舞いにしてある）
- [x] ~~**Erase EOF**（カーソルから欄末尾まで消去。欄からは出ない＝Field Exit の①だけ）~~
- [x] ~~**Erase Input**（全入力欄をクリア）~~

## 要確認（実機で確かめてから判断する）

- [x] ~~**符号付き数値の送信表現** `SHIFT_SIGNED_NUMERIC 0x0700`~~
  - **対応済み**（`.aidev/works/20260729-field-sign-dup-keys`）。**こちらの取りこぼしだった。**
    実測（実機・2026-07-30）:
    - `-12` を送ると**符号が黙って落ちて `12` になる**（エラーも出ない＝利用者は気づけない）
    - `    12-` を 7 バイトそのまま送ると **CPF5257（桁あふれ）**
    - 正解は **符号桁を送らず、最終桁のゾーンを 0xD にする**（`40 40 40 40 F1 D2` = −12）
- [x] ~~**EDTMSK 分解欄の境界をまたぐ操作**~~
  - **対応済み**（`.aidev/works/20260729-field-input-open-questions`）。
    原典（GNU tn5250 `display.c` の `kf_backspace`）は**欄の先頭では前の入力欄の末尾へ
    カーソルを移すだけで、1 文字も消さない**。そのとおりに実装した
  - **欄の中の Backspace は破壊的なまま**（PC の作法）。原典は既定で非破壊だが、
    そこを変えると既存利用者の操作が全部変わる。欄の先頭は原典も削除しないので食い違わない
- [x] ~~**数値専用欄に編集文字が入る構成**~~
  - **実在した。** `EDTCDE` / `EDTWRD` は**用途 B（入出力両用）でも書ける**（実機で
    コンパイル確認）。そのとき編集文字は EDTMSK のような分解をされず、**入力欄の中に入って**来る
    （実測 `in#1 len=8 numeric=true value="     .00"` shift=num-only）。
    「output-capable 向けだから入力欄には来ない」という見立ては誤りだった
  - **対応済み**（`.aidev/works/20260729-field-input-open-questions`）。許容集合は広げず、
    **「その欄の現在値に含まれる文字は通す」**（＝ホストが書いた文字は弾かない）とした。
    弾いていると**ホスト自身が書いた値を送り返せず、画面ごと送信できなくなる**
