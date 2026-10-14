# 調査: 文字端末（Windows Terminal・bash 等）の上で 5250 エミュレータを表現できるか

依頼: 利用者（2026-10-14）。検証 → 報告 → **利用者の確認を待つ**（実装へは進まない）。
試作は scratchpad（リポジトリ外）。再現手順は各項に書く。取れなかったものは「未確認」と明記する。

## 結論（先に）

**できる。ただし「描く」と「編集する」で難しさが違う。**

- **描く**側は素直: `ScreenSnapshot`（`cells` が 24×80 / 27×132 の格子、各セルに色・反転・下線・点滅・桁区切り・非表示）は、
  そのまま端末のセル格子に 1 対 1 で置ける。全角は 2 桁・右半分は出さない。差分描画も効く。
- **編集する**側が本体の工事: 欄内編集（挿入／上書き・DBCS の SO/SI 予算・Field Exit・右寄せ・検証・語送り・継続欄）の
  **ロジックが web-ui の Vue コンポーネント（`ScreenGrid.vue` 6,342 行・`EmulatorPane.vue` 1,965 行）に埋まっており、
  `packages/tn5250` に無い**。端末版が ACS 準拠の編集をするには、これを Vue から切り出す必要がある（§F9）。
  ここを写し直すと、web-ui と端末版で編集の結果が食い違う（AGENTS.md「ACS が正典」に反する）。
- 端末の種類で**確度が違う**: 実測できたのは tmux 3.4（WSL 内）だけ。Windows Terminal・conhost・VS Code 端末は**未確認**（§F10）。

## 判明した事実

### 画面と属性

- **F1（実測。試作 `render.mjs`）**: `Session5250` を `ReplayTransport` でフィクスチャ（`pub400-signon` / `pub400-jobinfo`）に流し、
  `snapshot()` のセルから SGR を組んで出せる。色 7 種は 24 ビット色（`38;2;r;g;b`）、反転 `7`・下線 `4`・点滅 `5`。
  24 行ぶん 2,893 バイト（24×80。27×132 は同密度で約 5,400 バイトと**概算**）。
- **F2（実測）**: 桁区切り（`columnSeparator`）は `4:4`（点線下線）が候補。tmux 3.4 は下線の副パラメータを無視して実線下線にする
  （**描かれ方の目視は未確認**。端末が `4:4` を解せるかは端末ごと）。代わりの見せ方: 入力欄の下線（`4`）だけにして桁区切りは捨てる、
  または欄を `_` で埋める。ACS の既定「点」は web-ui が CSS で描いており、文字端末では**情報を落とすことになる**（要判断・§質問）。
- **F3（コード）**: 高輝度・非表示（`nonDisplay`＝パスワード）・色は `Cell` が持つ。非表示は空白で描けば済む（`hidden` 欄の `value` は常に ""）。
  グリッド罫線（`GuiGridLine`）・窓枠（`GuiWindow`）・ラジオ／チェック（`GuiSelectionField`）は
  **罫線文字（`─│┌┐└┘`）で代替できるが、線種・色の指定は 1 桁単位に丸まる**。実装時に列挙して表にする（今回は試作していない＝**未確認**）。
- **F4（コード）**: 桁区切りの連なりの算出は `columnSeparatorRuns()`（`tn5250/src/screen/column-separator.ts`）に 1 か所。端末版もこれを使う。

### 画面サイズ

- **F5（コード＋推測）**: 5250 は 24×80 / 27×132 の**固定格子**で、端末の大きさに合わせて変えられない
  （サイズはセッション確立時に端末タイプで申告）。端末が足りないとき: 切り詰めて**左上を合わせる**／縮小は不可。
  余るとき: 中央寄せか左上固定。状態行の分（+1〜2 行）を足して **25×80 以上・28×132 以上**が要る。
  sodashitsu の端末版も同じ扱い（左上を合わせて切り取り、余りは背景色。`docs/tui.md`「画面」）。**この扱いは未試作**。

### 全角・幅（最大の落とし穴）

- **F6（実測。試作 `cpr.mjs`＝実端末へ書いて CPR `ESC[6n` で進んだ桁を読む。tmux 3.4・TERM=tmux-256color）**:
  `日`2・`ｱ`1・`ｶﾞ`2（濁点が独立の 1 桁を取る・**5250 の 1 桁と一致しない**）・`・`2・`～`2・`〜`2・`￥`2・`＼`2・`ー`2・`😀`2、
  **曖昧幅 `─│○●★①℃` は 1**。
  5250 の DBCS では `○●★─│` 等が**2 桁の全角**として届く（EBCDIC 939 の 2 バイト）。端末が 1 桁で描くと、**その行の右が 1 桁ずつ左へずれる**。
  逆に、東アジアロケールで曖昧幅を 2 にする端末（conhost の一部・設定で変えられる端末）は SBCS の `─` を 2 桁にする——**これは未確認**。
- **対処（設計方針。試作では未確認）**: 非 ASCII の 1 文字ごとに `CHA`（`ESC[<桁>G`）で**絶対位置へ置く**。幅の解釈が端末とずれても、
  ずれは 1 文字内に閉じ、行全体へ波及しない（sodashitsu `render/Screen.ts` も全角の右隣を無効化する同じ考え方）。
  描画先の幅を端末に問い合わせる（CPR）のは起動時 1 回で足りる。
- **F7（コード）**: 幅の判定は `@ts5250/base` の `isFullWidth` / `isCertainWideGlyph`（web-ui と共通）。端末版もこれを使えば web-ui と同じ幅になる。
  sodashitsu は xterm の unicode11 規則（`@xterm/addon-unicode11`）を使う。**どちらの規則で測るか**を一つに決める必要がある（§質問）。
- **F8（コード）**: SO/SI は `kind: "so"|"si"` で 1 桁（空白）。`dbcs-lead` を描き `dbcs-tail` を飛ばせば 80 桁が保たれる（試作でこの形で出している）。
  試作のフィクスチャ `synthetic-dbcs` は ccsid 1399 で開かないと DBCS にならない（SBCS で開くと SO/SI のバイトが文字化けする）——
  **日本語画面の目視での描画確認は今回していない**（未確認）。

### 入力

- **F9（コード・実測）**: 編集ロジックの所在。
  - 純関数で Vue 非依存: `composables/fieldEdit.ts`（`typeChar` / `insertChar` / `backspace` / `fieldExit` / `rightAdjust` / `paste`…）・
    `fieldSlices.ts`・`fieldValidate.ts`・`oFieldCells.ts`・`oChainCells.ts`・`wordWrap.ts`・`mandatoryCheck.ts`・`continuedRun.ts`
    （`vue` の import は無い。**ただし `@ts5250/tn5250/browser` と `@ts5250/base` に依存**）。
  - Vue に埋まっている: キー → 編集の配線・フォーカス移動・自動送り・エラー 0012 の保持・メッセージ解除・
    DBCS のライブ列ビュー（`ScreenGrid.vue` / `EmulatorPane.vue`）。
  - 試験は `packages/web-ui/test/` に約 16 本（`field-adjust` / `insert-no-room` / `dbcs-insert-sosi-room` …）。**共有に切り出せば端末版も同じ試験で守れる**。
- **F9b（実測。tmux 3.4 へ `send-keys` して、raw モードのプロセスが受けたバイト列を記録。試作 `keys.mjs`）**:

  | キー | 届いた列 | 備考 |
  |---|---|---|
  | F1〜F4 | `ESC O P`〜 | SS3 形式 |
  | F5〜F12 | `ESC [15~`〜`24~` | |
  | **Shift+F1 / F5 / F12** | `ESC [1;2P` / `[15;2~` / `[24;2~` | **F13〜F24 の割り当てに使える**（5250 の慣習どおり） |
  | Ctrl+F1 / F5 | `ESC [1;5P` / `[15;5~` | |
  | Alt+F1 | `ESC [1;3P` | |
  | PageUp / PageDown | `ESC [5~` / `[6~` | |
  | Home / End | `ESC [1~` / `[4~`（tmux の変換。xterm 直なら `ESC[H`/`[F`） | **端末ごとに違う** |
  | Insert / Delete | `ESC [2~` / `[3~` | |
  | Shift+Tab | `ESC [Z` | Backtab（フィールド戻り）に使える |
  | Ctrl+←→ | `ESC [1;5D` / `[1;5C` | カーソル頭出しに使える |
  | **Ctrl+1** | **無し（空）** | 届かない |
  | **Ctrl+Enter / Shift+Enter** | **Enter と区別できない／無し** | 5250 の Field Exit（ACS は右 Ctrl か Enter テンキー）を割り当てられない |
  | Esc | `ESC` 単独 | 続くバイトとの区別に時間切れが要る（sodashitsu は 25ms。`input/decode.ts`） |
  | Ctrl+Space | `NUL` | |

  → **Field Exit・Attn・SysReq・Help・Print・Clear・Record Backspace は文字端末では専用キーが無い**。代わりの割り当て
  （接頭キー方式〔`Ctrl+B` の次に押す〕か、Alt+文字）が要る。ACS の既定キー割り当てと対応表を作る必要がある（設計工程）。
  **Windows Terminal・conhost・VS Code 端末でのバイト列は未確認**（tmux は自前の変換表を挟むので、直の端末では違う可能性が高い。
  特に Home/End・Shift+F・Ctrl+矢印。modifyOtherKeys / kitty keyboard protocol を使えば区別は増えるが、**対応端末ごとの確認が要る**）。
- **F9c（コード）**: IME。端末の IME は**端末側が確定してから文字列として届ける**（プリエディット＝変換中の文字は届かない）。
  よってブラウザのような変換中表示（`composing`）は不要だが、**変換中の文字がどこに出るかは端末の描画に任せる**（カーソル位置の指定が要る）。**実機での確認は未確認**。
- **F9d（コード）**: マウス。`CSI ? 1006 h`（SGR 拡張）・`1002`/`1003` で座標とボタンが取れる（sodashitsu `input/mouse.ts`）。
  カーソル位置決め・GUI 選択肢（ラジオ／ボタン）の押下・ホイールでの PageUp/Down に使える。端末が対応しない場合はキーボードだけにする。**未実測**。

### 状態行・描き直し

- **F10（コード）**: オペレーター情報域（入力禁止・メッセージ待ち・挿入モード・カーソル位置）の元は
  `keyboardLocked` / `messageWaiting` / `systemMessage` / `sysReqLine` / `cursor`（`ScreenSnapshot`）。**端末版では 25 行目に自前で描く**。
- **F11（実測）**: 同期出力（DECSET 2026）に tmux 3.4 は**応答しない**（`ESC[?2026$p` に返事なし）＝非対応か問い合わせ非対応。
  対応していない端末へ送っても**無視される**ので、送ってよい（sodashitsu もそうしている）。ちらつきは差分描画で抑える。
- **F12（実測）**: 1 打鍵の差分は約 25 バイト（`CUP`+SGR+1 字）。全画面は約 2.9KB。**画面遷移（サインオン → メニュー）では 24 行すべてが変わる**ため、
  遷移は全画面に近い量になる。回線が遅い（SSH 越し）場合は遷移ごとに 1 画面ぶん。**ちらつきの目視は未確認**。

### 端末ごとの違い

| 端末 | 状態 |
|---|---|
| tmux 3.4（WSL の bash の中） | **実測した**（F6・F9b・F11） |
| Windows Terminal | **未確認**（この環境は WSL の中で、Windows 側の端末から起動できない） |
| conhost（古い Windows コンソール） | **未確認**。仮想端末シーケンス（VT）を要求する。曖昧幅の扱いが異なる可能性 |
| VS Code 端末 | **未確認** |
| 素の WSL bash（tmux 無し）| **未確認**（tmux が変換していない生のバイト列は未取得） |

「Windows Terminal・VS Code で確かめる」には、**利用者の環境で試作を 1 本動かしてもらう**必要がある（§質問）。

## 影響範囲

- 新設候補: **`@ts5250/terminal`（仮）**——ANSI 描画・キー解釈・端末の幅の問い合わせ。**依存は `tn5250` と `base` だけ**にし、`tn3270`・`vt`・
  `hostserver` と同位（`AGENTS.md`「パッケージ分割」）。`node:*` の import は `transport/` に隔離する決まりに合わせ、
  tty の読み書きだけを薄い層に分ける。
- 切り出し（**前提の工事**）: web-ui の `composables/{fieldEdit,fieldSlices,fieldValidate,oFieldCells,oChainCells,wordWrap,mandatoryCheck,continuedRun}.ts`
  は Vue 非依存なので、**`@ts5250/tn5250` へ移す**（web-ui からは直参照）。キー → 編集の配線は `ScreenGrid.vue` に埋まっているので、
  **Vue 非依存の「欄の編集セッション」へ抜き出す**必要があり、これが最大の変更。
  再輸出は置かない（`AGENTS.md` の方針）。web-ui の既存の約 16 本の試験は移送後も web-ui 側で緑のままにする（`dependency-direction` / `import-from-owner` の走査に注意）。
- 配布: `@ts5250/server` に `bin` を足すか、別の `bin`（例 `ts5250-term`）。ホストへは**今ある `Session5250` を直接**使えるので、
  サーバー越しにする必要は**無い**（直接接続）が、**サーバー越し（ws）にもできる**（ブラウザと同じセッションを共有したいとき）。どちらにするかは §質問。

## 実装アンカー

- 画面の源: `packages/tn5250/src/session/session.ts` `snapshot()`（501 行）・`sendAid()`（625 行）・`setField()`（518 行）・`waitForScreen()`
- 型: `packages/tn5250/src/screen/types.ts` `ScreenSnapshot` / `Cell` / `Field`
- 桁区切り: `packages/tn5250/src/screen/column-separator.ts`
- 幅: `packages/base/src/east-asian-width.ts`
- 編集: `packages/web-ui/src/composables/fieldEdit.ts` ほか（上記）
- 参考（読むだけ）: `/workspaces/sodashitsu/packages/tui/src/render/Screen.ts`（セル格子・差分描画・全角の右隣の無効化）、
  `input/decode.ts`（Esc の時間切れ・CSI の分解）、`render/width.ts`（幅）

## 勧める作り

1. **第 1 段（読むだけ・動く最小）**: 画面を描き、キー（Enter・F1〜F24・PageUp/Down）を AID として送れる。
   欄への入力は**上書きのみ・SBCS のみ**の最小版（`setField` で値を丸ごと置く方式）。ここまでは**編集の切り出しなしで**できる。
   MCP とは別の `bin`。目的: 端末ごとの違い（特に Windows Terminal）を実機で拾う。
2. **第 2 段（編集ロジックの切り出し）**: Vue 非依存の編集セッションを `tn5250` へ。web-ui の試験を緑に保ったまま移す。
   これは端末版が無くても価値がある（web-ui の ScreenGrid.vue が 6,342 行）が、**範囲が大きい**。
3. **第 3 段（編集の完全化）**: 挿入モード・DBCS 予算・Field Exit・検証・語送り・継続欄・エラー保持。
4. **第 4 段（GUI 構成要素・マウス・窓・罫線）**。

PR の切り方: 1 段 = 1〜2 PR。**第 2 段は単独で先に**出せる（挙動を変えない移送なので、web-ui の試験が回帰の網になる）。

## design への申し送り

- 幅の規則を 1 つに決める（`@ts5250/base` の `isFullWidth` 系か、unicode11 か）。**決めたら曖昧幅の扱いを設定で逃がす**（東アジア端末向け）。
- キー割り当ては ACS の既定表と突き合わせ、**届かないキーの代わり**を 1 表にする。割り当ては端末ごとに設定できるようにする。
- 非 ASCII 1 文字ごとに `CHA` で桁を固定する方針を、日本語実画面（939 の罫線を含む画面）で目視確認する（**Windows Terminal で**）。
- 桁区切りの代替（F2）は利用者の判断。ACS は点で描く。

## 未確認（まとめ）

- Windows Terminal / conhost / VS Code 端末 / 素の WSL bash のキー列・幅・同期出力・`4:4` 下線の描かれ方
- 日本語（DBCS）画面の目視での桁ずれの有無（今回は幅の測定と、セルの置き方の確認まで）
- 罫線・窓・GUI 選択肢の文字端末での再現の具体
- IME の実際の挙動
- マウスの座標・ボタンの実測
- 27×132 の描画速度（概算のみ）

## 利用者の判断（2026-10-14、報告後）

- **接続**: ts5250（`Session5250`）で直接接続する（サーバー越しにしない）。
- **端末ごとの確認**: Windows Terminal は、sodashitsu の端末版が問題なく表示できているので、改めて確かめない（利用者の判断。当 PJ 側の実測ではない）。
- **下線・桁区切り**: **画面定義（DDS）に従う**。出す・出さないは DDS が決めるので、端末版は代替の見せ方（縞・中点埋め等）を持たない。
  `Cell.underline` が真なら下線、`Cell.columnSeparator` が真なら桁区切りを描く。それ以外は何も足さない。
  → §F2 の案 A〜H のうち、独自の代替（D〜G）は採らない。桁区切りの描き方は ACS の既定（点）に最も近い `4:4`（点線の下線）とし、
  非対応端末で実線の下線になっても**ホストの指定の範囲内**として受け入れる（要件工程で再確認）。
- **SO/SI の補完**: `oFieldCells.ts` を端末から呼んで実現できることを確認した（第 2 段で正式に切り出す）。
