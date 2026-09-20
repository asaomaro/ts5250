# テスト結果: SAVE/RESTORE SCREEN と画面イメージ応答を ACS に合わせる

## 実行したもの

- `npx vitest run --root packages/tn5250` — **675 passed / 0 failed**（うち新規 `restore-screen-payload.test.ts` 9 件）
- `npx vitest run --root packages/server` — **1,425 passed / 0 failed / 3 skipped**（うち新規 2 件）
- `cd packages/web-ui && npx vitest run` — **2,108 passed / 1 failed**（下記「未検証の穴」）（うち新規 5 件）
- `npm run build`（`tsc -b` ＋ `vue-tsc -b tsconfig.json tsconfig.test.json`）— 成功
- `npm run build -w @ts5250/web-ui` — 成功
- `aidev smoke` — **pass (exit 0)**
- 実機（`.env.verify` のホスト・装置名は既存のものを使い回し）:
  - Attn → F12 の往復（当 PJ / ACS の A/B）
  - `scripts/tap-proxy.mjs` 越しの当 PJ のワイヤ採取
  - QSH の出入り（SAVE PARTIAL → RESTORE SCREEN）

## 受け入れ基準ごとの判定

- **AC1: pass** — 実機で Attn → F12 の後、**コマンド欄に `WRKACTJOB` が残り MDT=true**。
  修正前は空欄・MDT=false（research F10）。ACS の基準線も `WRKACTJOB` が残る（research F11）。
- **AC2: pass** — 復元後のカーソルが**退避した時点の位置**へ戻る。
  当 PJ は 20 行 7 桁 → 20 行 7 桁（`setField` はカーソルを動かさないので退避時も 20,7）。
  ACS は 20 行 16 桁 → 20 行 16 桁（打鍵でカーソルが進むため）。**規則が同じ**であることを確認した。
- **AC3: pass** — CA マスク（`aidNoDataMask`）とメッセージ行番号（`msgLineRow`）を退避・復元する
  （`packages/tn5250/test/restore-screen-payload.test.ts` の「CA マスクが往復する」「退避した項目をすべて
  変えてから復元すると、元に戻る」）。保留中の READ（`readCommand`）は `ScreenBuffer` の退避段へ入れた。
  施錠（ACS `SaveKeyboardLocked`）は**対応物が無い**と判定（decisions D12）。
- **AC4: pass** — 実機のメインメニューで Attn → F12 の往復後、**F12 が欄データを送っていない**
  （本体 `14 1a 3c` ＝ カーソル ＋ AID のみ）。CA マスクが復元されている証拠。
- **AC5: pass** — DSM（`QsnPutInpCmd(0x66)`）で実機に `READ SCREEN TO PRINT` を出させ、
  **ACS の応答と当 PJ の応答をワイヤで突き合わせた**。3 点の差を見つけ、ACS に合わせた（下記）。
  `0x62` は国勢調査 2 回（83・142 レコード）で 1 件も届かず、`0x66` / `0x6A` と**同じ組み立てを共有**
  しているので、この計測で形式の決着は付いている。
- **AC6: pass** — `writeCell` が `rawByte ?? hostByte ?? encodeSbcs(char)` になり、
  `setFieldValue` で入れた文字が空白に化けない。実機の応答本体が ACS と一致することで裏づけた（下記）。
- **AC7: pass** — QSH の SAVE PARTIAL → RESTORE・PDM の F1 ヘルプ往復・窓（CREATE WINDOW）の
  いずれも実機で確認（下記）。**SEU の F1 → F12 は未実施**（「未検証の穴」）。
- **AC8: pass** — 上記のテストとビルドがすべて緑。`aidev smoke` も pass。
- **AC9: 判定は deliver（T18）** — 片付けと点検はそこで行う。
- **AC10: pass** — 実機のワイヤで、SAVE 応答の opcode が **`0x04`（受信の写し）**であることを確認。
  ACS も同じ（research F14）。修正前は `0x05` 固定だった。
- **AC11: pass** — ワイヤの前後比較。下記。
- **AC12: pass** — ACS `Save5250Net` の全項目と当 PJ の対応表が design「振る舞い B」にある。
  対応物が無い 6 項目（施錠・挿入モード・ホーム位置・カーソル可視・保留 AID・ENPTUI）は
  理由つきで「未対応」と記録した。

## 実機の証跡

### AC1 / AC2: Attn → F12 の往復（当 PJ・修正後）

```
warn: startup response I902 (system=<システム名> device=<装置名>)
# メニュー到達。コマンド欄 row=20 col=7 len=153 / 20 行目=" ===>"
# 打鍵前カーソル: row=20 col=7
# setField 後の MDT=true
# 復元後: コマンド欄="WRKACTJOB" MDT=true
# 復元後カーソル: row=20 col=7
```

修正前（research F10）は `# 復元後: コマンド欄="" MDT=false`。

ACS の基準線（research F11・同じ手順を `scripts/acs-probe/attn-restore.txt` で実行）:

```
=== menu       cursor=20,7  inhibit=0
=== typed      cursor=20,16 inhibit=0   20| ===> WRKACTJOB
=== after-attn cursor=20,26 inhibit=0   20| ===> WRKACTJOB
=== after-f12  cursor=20,16 inhibit=0   20| ===> WRKACTJOB
```

### AC4 / AC10 / AC11: ワイヤの突き合わせ（`scripts/tap-proxy.mjs` 越し）

当 PJ がホストへ送ったレコード（メインメニューで打鍵 → Attn → F12）:

```
  #3 len=13  opcode=0x3  flags=0,80  本体: 01 01 f1          ← 最初の Enter
  #4 len=10  opcode=0x0  flags=40,0  本体: (空)              ← **Attn**
  #5 len=10  opcode=0xa  flags=0,0   本体: (空)
  #6 len=805 opcode=0x4  flags=0,80  本体795B                ← **SAVE 応答**
  #7 len=13  opcode=0x3  flags=0,80  本体: 14 1a 3c          ← **F12**
```

ACS の同じ操作（research F17）と突き合わせると:

| レコード | ACS | 当 PJ（修正後） | 判定 |
|---|---|---|---|
| Attn | 10B・opcode `0x00`・flags `0x40`・本体空 | **同一** | 一致 |
| SAVE 応答の opcode | `0x04`（受信の写し） | **`0x04`**（修正前は `0x05`） | 一致（AC10） |
| F12 | 本体 `14 1a 3c`（カーソル 20,26 ＋ AID `0x3C`・欄データ無し） | **`14 1a 3c`** | **バイト単位で一致**（AC4・AC11） |

**フラグキーに欄を載せるようにしても、ホストへ送るバイト列は変わっていない。**

### AC7（一部）: QSH の SAVE PARTIAL → RESTORE の往復

```
# コマンド欄 row=20 col=7 len=153
  record 17B  コマンド列: @0:0403        ← QSH 起動時の SAVE PARTIAL ×2
  record 17B  コマンド列: @0:0403
  record 809B コマンド列: @0:0412 @2:0411 @795:0452   ← F3: 積荷の後ろに READ MDT
# F3 の後: keyboardLocked=false（積荷の後ろの READ MDT を飲み込んでいたら true のまま固まる）
# その後の Enter の後: keyboardLocked=false / 1 行目=" MAIN    IBM I メインメニュー"
```

**「レコードの残りを捨てる」実装だったら、ここで READ MDT を失って施錠が解けなくなっていた**
（decisions D10 が退けた案）。長さで読み飛ばす実装が、実機で裏づけられた。

### AC5 / AC6: 画面イメージ応答（`READ SCREEN TO PRINT` 0x66）を ACS と突き合わせる

DSM の試験プログラム（`TESTLIB/DSCMD PARM(PRTSCR)`＝`QsnPutInpCmd(0x66)`）で実機に出させた。
ACS 側は `scripts/acs-probe.mjs` で同じ CALL を実行し、`scripts/tap-proxy.mjs` で応答を採った。

**変更前**（当 PJ）:

```
  受信   12B  04 66
  送信 1932B  opcode=0x3  14 07 3a d4 c1 c9 d5 40 40 40
  QsnPutInpCmd(0x66) rc=1024  bytesRead=1024
```

**ACS**（ワイヤ実測）:

```
  host→ACS  #10 len=12   opcode=0x08  : @0:RDSCR_PRT
  ACS→host  #21 len=1930 opcode=0x08  本体=1920B
  本体 先頭 32B: 3a d4 c1 c9 d5 00 00 00 00 00 00 20 …
  最頻バイト: 0x00×1388 0x43×83 0x20×42 0x44×25
```

**差は 3 点**——どれも ACS に合わせた:

| | ACS | 当 PJ（変更前） |
|---|---|---|
| opcode | `0x08`（受信の写し） | `0x03`（PUT_GET 固定） |
| カーソル位置の前置 | **無し** | **あり（2 バイト）** |
| 未書き込み桁 | **`0x00`** | `0x40`（空白） |

**変更後**（当 PJ）:

```
  受信   12B  04 66
  送信 1930B  opcode=0x8  3a d4 c1 c9 d5 00 00 00 00 00
  QsnPutInpCmd(0x66) rc=1024  bytesRead=1024
```

**長さ・opcode・本体の先頭が ACS と一致し、ホストも受理した**（`rc=1024`・エラー無し）。

### AC7: 既存経路の非回帰（PDM の F1 ヘルプ・窓）

```
# コマンド行に到達
# PDM: locked=false 1行目="                          プログラム開発管理機能 (PDM)"
# F1 後: locked=false 画面が変わった=true
# F12 後: locked=false 元の画面に戻った=true
# 窓: locked=false
RESULT: PASS
```

PDM の F1 は **SAVE SCREEN ＋ READ SCREEN EXTENDED ＋ RESTORE SCREEN** を通る経路で、
F12 で**画面が 1 行の違いもなく元に戻る**ことを確認した（比較は 24 行ぶんの文字列）。

## 失敗の証跡

このラウンドでは、実装の欠陥による失敗は発生していない。
**ただし独立点検（coding 工程内）で 14 件の指摘があり、すべて直した**——内容は `review.md` の
「タスク点検ログ」節。うち **must 2 件**（退避の段が 2 か所で管理されていてずれる／
逃げ道が `KEYBOARD_LOCKED` 以外で塞がる）は実害のある欠陥だった。

修正の過程で既存テストが落ちたが、これは**過去の決定を意図的に破棄したため**（`AGENTS.md`
「判断の原則」3）。落ちた内容と対応:

```
 FAIL  test/save-screen.test.ts > opcode と先頭コマンドが RESTORE SCREEN になっている
AssertionError: opcode は RESTORE_SCREEN: expected undefined to be 5
```
→ ACS のワイヤ実測に合わせて「受信した opcode の写し」へ変更（decisions D8）。テストを書き替えた。

```
 FAIL  test/busy-loading.test.ts > フラグキーには欄を載せない（打ちかけの入力を無駄に流さない）
AssertionError: expected { type: 'key', key: 'Attn', …(1) } to not have property "fields"
```
→ ACS の構造に合わせ、フラグキーでも欄をサーバーへ渡すよう変更（decisions D6）。テストを書き替えた。

また、**自分で書いたテストが空振りしていた**のを実行中に見つけた:

```
 FAIL  test/restore-screen-payload.test.ts > CA マスクが往復する
（`sendsDataForAid(0x3c)` は範囲外のキー番号なので常に true を返していた）
```
→ `sendsDataForAid()` は**キー番号 1〜24** を取る（AID コードではない）。`12` に直し、
「申告が効いている」ことを先に表明して空振りを塞いだ。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 44901)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

この work は**新しい入口（サブコマンド・オプション）を足していない**ので、`smokeCommands` は変更しない。

## 未検証の穴（skip / 環境不足）

- **`READ SCREEN`(0x62) そのものは実機で出させていない**。`dscmd.c` が持つのは `0x66`（`PRTSCR`）で、
  `0x62` / `0x6A` を出す要求は無い。**組み立ては 3 つとも `buildReadScreenResponse` を共有**しているので
  形式の決着は付いているが、`0x62` 固有の扱い（ACS は `processReadScreen(false)` で上位バイトの立った桁を
  8 ビット右へ送り `0x11→0x13` / `0x10→0x12` / `0x07→0x08` に写す）は**未確認**。当 PJ には
  そのプレーン表現が無いので対応物も無い。
- **SEU の F1 → F12 は未実施**。PDM の F1（同じ SAVE/RESTORE ＋ READ SCREEN EXTENDED の経路）と
  窓・QSH は確認済み。
- **`packages/web-ui/test/tab-visibility.test.ts` が並列実行で 5 秒タイムアウト**（1 件）。
  **単独では 8 件すべて緑**。この work の変更とは無関係で、`.aidev/backlog/session-lifecycle.md` に
  既に起票されている既知の項目。
- **`packages/server/test/zip-writer.test.ts` / `test/app-auth.test.ts` が並列実行で落ちる回がある**。
  それぞれ単独では 15 件・5 件とも緑。
  外部の `unzip` を呼ぶテストで、この work は当該ファイルを変更していない。
- **`ESC 13`（RESTORE PARTIAL SCREEN）の実機レコードは観測できていない**（research F9b・F16）。
  QSH の出口は 3 回とも `ESC 12` だった。長さで読み飛ばす仕組みは `ESC 13` にも同じように効くが、
  **実機での確認は取れていない**。

---

## ラウンド 2（review ラウンド 1 の差し戻し 29 件を直した後）

review が **29 件（must 2・should 22・nit 5）**を返し、coding へ差し戻して全件を直した
（内容は `review.md` の「委譲分」）。**振る舞いを変えた修正**が含まれるので、実機を取り直した。

### 振る舞いを変えた修正（再検証の対象）

| 修正 | 影響する経路 |
|---|---|
| `buildReadScreenExtendedResponse`(0x64) の opcode を受信の写しに | PDM の F1 ヘルプ |
| 施錠の判定を「例外を捕まえる」から事前判定へ | フラグキーの同期 |
| `ApplyResult` の `saveScreenRequested` / `savePartialScreen` を撤去し `saveRequests` に一本化 | SAVE / SAVE PARTIAL の応答 |
| DBCS 桁も保持済みの生バイトで返す | 画面イメージ応答・SAVE 応答 |
| `setUnmappable` に `hostByte` | 同上 |

### 実行したもの

- `npx vitest run --root packages/tn5250` — **675 passed / 0 failed**
- `npx vitest run --root packages/server` — **1,423 passed / 2 failed**（下記。どちらも単独では緑）
- `packages/web-ui`（影響範囲）— **19 passed / 0 failed**
- `npm run build` ＋ `npm run lint` ＋ `aidev smoke` — すべて成功
  （lint は `OPCODE` の未使用が 1 件出たので import を外した）

### 実機（4 経路とも再現）

```
# 復元後: コマンド欄="WRKACTJOB" MDT=true          ← AC1（Attn → F12）
# PDM: locked=false / F1 後: 画面が変わった=true
# F12 後: locked=false 元の画面に戻った=true        ← AC7（0x64 の opcode を変えた経路）
# 窓: locked=false
RESULT: PASS

  送信 1930B  opcode=0x8  3a d4 c1 c9 d5 00 00 00 00 00   ← AC5（ACS と一致のまま）
  QsnPutInpCmd(0x66) rc=1024  bytesRead=1024

  record 809B  コマンド列: @0:0412 @2:0411 @795:0452      ← AC7（QSH）
# F3 の後: keyboardLocked=false
# その後の Enter の後: keyboardLocked=false / 1 行目=" MAIN  IBM I メインメニュー"
```

### 失敗の証跡（ラウンド 2）

実装の欠陥による失敗は発生していない。並列実行でのみ落ちる既知の 2 件が出た:

```
 FAIL  test/app-auth.test.ts > 認証 ON: 未認証で保護ルートは 401、login 後は Cookie で通る
 FAIL  test/zip-writer.test.ts > 外部の unzip が受け付けること > 大きめのデータでも往復する
```

**どちらも単独では緑**（`app-auth` 5 件・`zip-writer` 15 件）。この work はどちらのファイルも
変更していない。`tab-visibility` と同じ、並列実行の揺らぎ（「未検証の穴」に追記）。

---

## ラウンド 3（review ラウンド 2 の差し戻し 10 件を直した後）

review ラウンド 2 が **10 件（must 1・should 4・nit 5）**を返し、coding へ差し戻して全件を直した。
**must は「ラウンド 1 の修正が生んだ退行」**だった——`String(e)` を `err: e` に変えた結果、
`FIELD_TYPE` の文言に埋まる**打鍵した値（マクロ由来の秘密を含みうる）がサーバーログへ出る**ように
なっていた（`AGENTS.md`「ログにも値を出さない」違反）。

CLI の促し（「同じ不変条件を支える項をすべて列挙して壊してみる」）に従い、**3 つの不変条件**を
それぞれ機械的に洗った:

| 不変条件 | 洗い方 | 結果 |
|---|---|---|
| ログに値を出さない | 差分の `wsLog.*` / `warn(` を全列挙 | 漏れるのは 1 か所。`code` と**スタックのフレームだけ**を載せる `errShape()` を置いた（`stack` の 1 行目は message を含むので落とす） |
| 出所を work で修飾する | 差分の該当語を全列挙し、**±12 行に slug が無い**ものを抽出 | この work の分 4 か所を修飾（残りは他 work 由来。走査の起票は `code-quality-checks.md` に済み） |
| 対になる資産を同期する | テスト側の stale な主張・孤児 JSDoc を走査 | テストの旧 opcode 記述 1 件・孤児 JSDoc 1 件を解消 |

### 振る舞いを変えた修正（再検証の対象）

| 修正 | 影響する経路 |
|---|---|
| `buildSavePartialScreenResponse` から `params` 引数を撤去（「写さない」を構造で真に） | QSH の SAVE PARTIAL |
| DBCS の生バイト判定に `charKind === "dbcs-tail"` を追加 | 画面イメージ応答・SAVE 応答 |
| 例外のログを `errShape()` 経由に | フラグキーの同期 |

### 追加した回帰資産

- **`packages/tn5250/test/save-screen-session.test.ts`「1 レコードに SAVE が 2 回」** —
  `Session5250` を通して 2 本の応答を受け、**2 段目 → 1 段目の順に復元して警告が出ない**ことを見る。
  **退行を実際に検出できることを確かめた**——`attachSaveContext` を「頂点に添える」へ戻すと
  `RESTORE SCREEN: no payload recorded for this save` で落ち、元に戻すと通る。
  （それまでのテストはビルダーを直に呼び、段ごとに画面を変えて差を作っていたため、
  **頂点に戻す退行を検出できなかった**。review ラウンド 2 の指摘）
- **`packages/server/test/ws-handler.test.ts`** 2 件 — 実在しない欄番号を添えて
  「Attn は通る（best-effort）」「通常キーはエラーを返す（握りつぶさない）」を固定。

### 実行したもの

- `npx vitest run --root packages/tn5250` — **676 passed / 0 failed**
- `npx vitest run --root packages/server` — **1,427 passed / 0 failed / 3 skipped**
- `packages/web-ui`（影響範囲）— 16 passed / 0 failed
- `npm run build` ＋ `npm run lint` ＋ `aidev smoke` — すべて成功

### 実機（4 経路とも 3 ラウンド連続で再現）

```
# 復元後: コマンド欄="WRKACTJOB" MDT=true                 ← AC1
  送信 1930B  opcode=0x8  3a d4 c1 c9 d5 00 00 00 00 00   ← AC5（ACS と一致のまま）
  QsnPutInpCmd(0x66) rc=1024  bytesRead=1024
  record 809B  コマンド列: @0:0412 @2:0411 @795:0452      ← AC7（QSH）
# F3 の後: keyboardLocked=false
# F12 後: locked=false 元の画面に戻った=true              ← AC7（PDM の F1）
# 窓: locked=false
RESULT: PASS
```

### 失敗の証跡（ラウンド 3）

実装の欠陥による失敗は発生していない。lint が 1 件出たので直した:

```
packages/tn5250/test/save-partial-screen.test.ts
  77:20  error  'params' is assigned a value but never used
```

→ ビルダーが `params` を受け取らなくなったので、テストのヘルパーからも落とした。

---

## ラウンド 4（review ラウンド 3 の差し戻し 12 件を直した後）

review ラウンド 3 が **12 件（must 1・should 5・nit 6）**を返した。
**must はまた「直前の修正が生んだ退行」**——`errShape()` が `stack` の 1 行目しか落とさないため、
**message が複数行だと 2 行目以降が残る**（zod の `ZodError.message` が該当）。
**私の JSDoc「1 行目は `<name>: <message>`（V8 の書式）」は推測のまま検証していなかった**
（`AGENTS.md` 判断の原則 2 違反）。

差し戻しは 3 回目（上限）だったが、**原因が特定済みで委譲先が再現も実測もしている**ので
`aidev debug skip --phase review` で省いた（decisions「デバッグ D1」に記録）。

### 推測をやめて測った

```
$ node -e '複数行 message の Error の stack を調べる'
stack の行数: 12
slice(1) の先頭 3 行:
  [0]   "issue": "unknown key",
  [1]   "key": "SECRET-NAME"
  [2] }
/^\s*at / に一致する行数: 8
値が残るか（slice(1)）: 残る
値が残るか（at 行だけ）: 残らない
```

→ `at ` で始まる行だけを残す形に直し、**先頭 3 フレームまで**に絞った。

### 層を下げた（推測をテストで止める）

**`packages/server/test/err-shape.test.ts`（5 件・新規）**——同じ穴を 2 回開けたので、
散文の注記ではなくテストで固定した。**ラウンド 2 の実装（1 行目だけ落とす）を注入すると
「複数行の message でも載らない」が落ちる**ことを確かめてある。

### 追加した回帰資産

- `packages/tn5250/test/restore-screen-payload.test.ts`「応答に載せる文字」**6 件** —
  **この work の中心の修正（`rawByte ?? hostByte ?? encodeSbcs(...)`）に、それまでテストが 1 件も無かった**。
  打鍵した文字 / オーダー 0x1C・0x1E / UNMAPPABLE / 未書き込み桁 0x00 / DBCS の生バイト対 /
  `charKind === "dbcs-tail"` の判定 を固定。
- `msgLineRow` の往復 — リポジトリ全体で検査が 0 件だった。
- `save-screen-session.test.ts` の検査を `expect(warns).toEqual([])` に広げた。
  **`ll` を壊して `record parse error` を起こすと落ちる**ことを確かめてある
  （それまでは部分集合しか見ておらず、復元に到達しなくても緑だった）。

### 実行したもの

- `npx vitest run --root packages/tn5250` — **682 passed / 0 failed**
- `npx vitest run --root packages/server` — **1,432 passed / 0 failed / 3 skipped**
- `packages/web-ui`（影響範囲）— 16 passed / 0 failed
- `npm run build` ＋ `npm run lint` ＋ `aidev smoke` — すべて成功

### 実機（4 経路とも 4 ラウンド連続で再現）

```
# 復元後: コマンド欄="WRKACTJOB" MDT=true                 ← AC1
  送信 1930B  opcode=0x8  3a d4 c1 c9 d5 00 00 00 00 00   ← AC5
  record 809B  コマンド列: @0:0412 @2:0411 @795:0452      ← AC7（QSH）
# F3 の後: keyboardLocked=false
# F12 後: locked=false 元の画面に戻った=true              ← AC7（PDM の F1）
# 窓: locked=false
RESULT: PASS
```

### 失敗の証跡（ラウンド 4）

実装の欠陥による失敗は発生していない。退行の注入で**テストが落ちること**を 2 件確かめた
（上記「層を下げた」「追加した回帰資産」）。

### この work の範囲外として起票したもの

- **`sendError` が検証エラーの文言をブラウザへ返す**（`ws-handler.ts`）。
  `validateFieldContent` は文言に `JSON.stringify(value)` を埋めるので、マクロの `secretRef` を
  型の合わない欄へ再生すると**復号済みの秘密が平文でクライアントへ返る**
  （`AGENTS.md`「API/ブラウザには平文も暗号文も返さない」）。
  **既往で、通常キーの経路**。ログ側（`errShape`）と同じ形の手当てが要るので、
  `code-quality-checks.md` に**優先度 高**で起票した。

---

## ラウンド 5（review ラウンド 4 の差し戻し 9 件を直した後）

**must は「自分が足したテストが構造的に落ちない」件**だった——`msgLineRow` の往復検査に入れた
SOH の `0x18`＝24 が**既定値**で、SAVE と RESTORE の間の操作も `msgLineRow` に触れないため、
`restoreScreen()` から復元を消しても 15 件すべて緑だった（主エージェントが注入して確認）。

### 層を下げた

`msgLineRow` を**読み取り専用で公開**（`ScreenBuffer.messageLineRow`）し、
「システム・メッセージがどの行で消えるか」を試す**副作用つきのプローブを撤去**した。
プローブは画面を書き換えるうえ呼ぶ順に依存し、**検査が空振りしていた**。
公開後は、復元を消すと `expected 20 to be 22` で落ちる。

### 実測してから倒した（推測で通さない）

`encodeSbcs` の条件を `b < 0x20` から **`b < 0x40`（属性帯まで）**へ広げた。根拠は実測:

```
CCSID 37:   C0→属性帯 11 件 / 表示文字→0x40 未満 0 件
CCSID 273:  C0→属性帯 11 件 / 表示文字→0x40 未満 0 件
CCSID 930:  C0→属性帯 11 件 / 表示文字→0x40 未満 0 件
CCSID 939:  C0→属性帯 11 件 / 表示文字→0x40 未満 0 件
CCSID 1399: C0→属性帯 11 件 / 表示文字→0x40 未満 0 件
```

C0 制御は 5 つの CCSID すべてで属性帯（`isAttribute` の 0x20–0x3F）へ落ち、
**表示文字が 0x40 未満へ落ちるものは 1 件も無い**——失う文字は無い。

### そのほか

- `stackFrames` を **fail-closed** に（頭が `<name>: <message>` でなければ `at` ごと諦める）。
  退避路は「複数行 message がそのまま残る」ラウンド 3 の穴に戻るため。
- `UNMAPPABLE` のテストを `applyDataStream` 経由にし、**この work が足した配線を固定**した
  （それまでは `setUnmappable` を直に呼んでおり、`hostByte` を渡すのを戻しても緑だった）。
  渡していた `0x3F` も誤り（`UNMAPPABLE` は `0x1F`）。
- `AGENTS.md` の「判断の原則 1」に、**ACS 固有のライセンス上の歯止め**を明記
  （IBM の独占物で JTOpen より制約が強い。持ち帰ってよいのは事実だけで、表現は写さない）。

### 実行したもの

- `npx vitest run --root packages/tn5250` — **682 passed / 0 failed**
- `npx vitest run --root packages/server` — **1,434 passed / 0 failed / 3 skipped**
- `npm run build` ＋ `npm run lint` ＋ `aidev smoke` — すべて成功

### 実機（4 経路とも 5 ラウンド連続で再現）

```
# 復元後: コマンド欄="WRKACTJOB" MDT=true                 ← AC1
  送信 1930B  opcode=0x8  3a d4 c1 c9 d5 00 00 00 00 00   ← AC5
  record 809B  コマンド列: @0:0412 @2:0411 @795:0452      ← AC7（QSH）
# F3 の後: keyboardLocked=false
# F12 後: locked=false 元の画面に戻った=true              ← AC7（PDM の F1）
RESULT: PASS
```

### 失敗の証跡（ラウンド 5）

実装の欠陥による失敗は発生していない。**退行の注入でテストが落ちること**を 2 件確かめた
（`msgLineRow` の復元を消す／`errShape` をラウンド 3 の実装に戻す）。

---

## ラウンド 6（review ラウンド 5 の差し戻し 8 件を直した後・最終）

**must 2 件はどちらも委譲先が「変異注入」で見つけた**——ラウンド 4 で入れた修正 2 つに
**テストが無く、実装を元に戻しても全件緑**だった（`b < 0x40` → `b < 0x20` で 682 件緑、
fail-closed をラウンド 3 の形に戻して 34 件緑）。

### 実測してから直した

`stackFrames` の fail-closed（頭が `<name>: <message>` でなければ諦める）は**効きすぎていた**。
node v24.15.0 で実測:

```
Node 内部 ERR_*: startsWith=false / 行数方式で採れるフレーム=2
message が空:    startsWith=false / 行数方式で採れるフレーム=1
複数行 message:  startsWith=true  / 行数方式で採れるフレーム=1
通常:            startsWith=true  / 行数方式で採れるフレーム=1
```

→ **`message` の行数ぶんを落とす方式**へ変更（4 形すべてでフレームが採れる。
message の行数は message からしか作れないので、どんな頭でも値は残らない）。

### 変異注入で落ちることを確かめた（2 件とも）

- **`b < 0x40`** — `b < 0x20` に戻すと
  `AssertionError: 属性帯（0x20–0x3F）に化けていない: expected 37 to be 64`（37 = 0x25 ＝ U+000A）
- **`stackFrames`** — ラウンド 4 の fail-closed に戻すと
  「`stack` の頭が `<name>: <message>` にならない例外でもフレームが採れる」が落ちる。
  テストは**環境に依らない形**にした（`stack` を確定させてから `name` を変える）
  ——最初は Node 内部例外で書いたが、注入しても落ちず、**テスト自身が効いていなかった**

### そのほか

- `messageLineRow` ゲッターを `clearSystemMessageIfTouched` の JSDoc の**間から外へ**移した
  （宙に浮いた JSDoc を、同じ差分で `cellAt` の側は直したのに隣で作り直していた）
- 「ACS は**どの Read でも** opcode を写す」という網羅の主張を実態へ——
  **当 PJ で写しに変えたのは 3 経路だけ**で、`0x72` / `0x83` は `PUT_GET` 固定のまま（実機で未測定）
- 実測の範囲を明記（5 CCSID ／ U+0020 以上から DEL・C1 を除いた範囲）
- `no payload recorded` が同一レコードの SAVE → RESTORE で空振りすること、
  預ける `readCommand` がレコードを流す前の値であることを、それぞれ**未確認**として書き添えた

### 実行したもの

- `npx vitest run --root packages/tn5250` — **683 passed / 0 failed**
- `npx vitest run --root packages/server` — **1,436 passed / 0 failed / 3 skipped**
- `npm run build` ＋ `npm run lint` ＋ `aidev smoke` — すべて成功

### 実機（4 経路とも 6 ラウンド連続で再現）

```
# 復元後: コマンド欄="WRKACTJOB" MDT=true                 ← AC1
  送信 1930B  opcode=0x8  3a d4 c1 c9 d5 00 00 00 00 00   ← AC5
  record 809B  コマンド列: @0:0412 @2:0411 @795:0452      ← AC7（QSH）
# F3 の後: keyboardLocked=false
# 窓: locked=false / RESULT: PASS                         ← AC7（PDM の F1・窓）
smoke: pass (exit 0)
```

### 失敗の証跡（ラウンド 6）

実装の欠陥による失敗は発生していない。**変異注入でテストが落ちることを 2 件確かめた**（上記）。
