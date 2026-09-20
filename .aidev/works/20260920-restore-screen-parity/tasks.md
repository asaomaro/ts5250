# タスク: SAVE/RESTORE SCREEN と画面イメージ応答を ACS に合わせる

## 実装方針

下から積む。**まず退避の器を広げ（T1〜T3）、次に読み飛ばしを入れ（T4）、その後で
セッション層の状態（T5）と対応表の確定（T6）へ進む。** 応答の形（T7・T8）と
打鍵の同期（T9・T10）は独立に進められる。

**実機で確定する項目は test 工程で消化する**（T13〜T17）。design「設計方針」のとおり、
この work では「未確認」を推測で埋めない（`AGENTS.md`「判断の原則」2）。

## 作業順序と依存関係

- **T6（ACS の退避一覧との対応表の確定）は T1・T5 より前に済ませてもよいが、
  「未確認」4 項目の答え次第で T1 / T5 の退避項目が増える**ので、先に手を付ける。
- T4 は T2（`restoreScreen()` が積荷を返す）が無いと書けない。
- 残りは下の `依存:` に従う。

## リスク / 留意点

- **`updateScreen()` / `edits.clear()` は触らない**（design C）。触ると全セッションの画面更新に掛かる。
- **既存テストが固定している振る舞いを壊さない**——
  `save-partial-screen.test.ts:135`・`:196`（RESTORE PARTIAL の後続が生きる）、
  `system-message-lifetime.test.ts:79-90`（SAVE でメッセージを消す）。
  積荷が無ければ 0 バイト読み飛ばしなので、どちらも保たれるはず。**確かめる。**
- **`save-screen.test.ts:32` は opcode 0x05 を固定している。T7 で書き替える**
  （decisions D8。過去の決定を破棄する側）。
- 実機の装置名は使い回す。DSM 資材を作ったら片付ける。
- scratchpad の中継ログには秘密が残る。解析が済んだら消す。

## テスト方針

- **単体**: `packages/tn5250/test/` に、積荷の読み飛ばし（一致／不一致／積荷無し／後続の READ が生きる）・
  退避項目の往復・opcode・`writeCell` の符号化を足す。
- **結合**: `packages/server/test/` と `packages/web-ui/test/` に、フラグキーの同期
  （施錠中は同期しない／送信バイト列が変わらない）を足す。
- **実機**: Attn→F12 の A/B（ACS と当 PJ）、`CAnn` 画面、SEU F1→F12・PDM F1・QSH・窓の非回帰、
  DSM で `0x62`/`0x66`/`0x6A` を出させた応答の突き合わせ、ワイヤの前後比較。
- **起動確認**: `aidev smoke`。

## タスク

- [x] T1: 退避スタックの型に `savedPayload` / `aidNoDataMask` / `msgLineRow` を足し、`saveScreen()` で積む
      対象: `packages/tn5250/src/screen/buffer.ts:514-530` `savedStack` / `:564` `saveScreen()` / 根拠: design「インターフェース 1」, research F1・F8
      依存: なし
      AC: AC3
- [x] T2: `restoreScreen()` が復元した段の積荷を返すようにする（戻り型を `boolean` から変える）
      対象: `packages/tn5250/src/screen/buffer.ts:620-641` `restoreScreen()` / 根拠: design「インターフェース 2」
      依存: T1
      AC: AC3
- [x] T3: SAVE / SAVE PARTIAL 応答の本体を、組み立てた直後に退避段へ添える配線
      対象: `packages/tn5250/src/session/session.ts:609-619` と `buffer.attachSavePayload()`（新規） / 根拠: design「インターフェース 2」
      依存: T1
      AC: AC3
- [x] T4: `RESTORE_SCREEN` / `RESTORE_PARTIAL_SCREEN` で積荷を長さで読み飛ばす（全バイト一致を確認。不一致は警告して現状どおり）
      対象: `packages/tn5250/src/protocol/wtd-applier.ts:204-206` `:218-229` / 根拠: design「振る舞い A」, decisions D2・D10, research F9b・F16
      依存: T2, T3
      AC: AC1, AC2
- [x] T5: 保留中の READ（`readCommand`）と施錠（`state`）をセッション層で退避・復元する
      対象: `packages/tn5250/src/session/session.ts:161` `readCommand` / `:135` `state` / 根拠: design「インターフェース 3」, research F1（ACS `SavePendingRead` / `SaveKeyboardLocked`）
      依存: T3
      AC: AC3
- [x] T6: ACS `Save5250Net` の退避一覧と当 PJ の対応表を**現物で**確定する（design B の表の「未確認」4 項目）
      対象: 未特定（`packages/web-ui/src` の挿入モード、`buffer.ts` のカーソル可視・ホーム位置・IC アドレス相当を探索）/ 根拠: research F1, design「振る舞い B」
      依存: なし
      AC: AC12
- [x] T7: SAVE / SAVE PARTIAL 応答の opcode を「受信したレコードの opcode の写し」にする
      対象: `packages/tn5250/src/protocol/save-screen.ts:29` `buildSaveScreenResponse` / `:90-97` / `packages/tn5250/src/session/session.ts:611` `:617` / 根拠: research F14, decisions D8
      依存: なし
      AC: AC10
- [x] T8: `writeCell` の既定を「`rawByte` が無ければコードページで符号化」にする（意図的に付けない箇所は個別に判断）
      対象: `packages/tn5250/src/protocol/save-screen.ts:231-244` `writeCell` / 根拠: research F3・F4・F10, decisions D4
      依存: なし
      AC: AC6
- [x] T9: web-ui: フラグキー（Attn / SysReq）でも `fields` を載せる
      対象: `packages/web-ui/src/session-controller.ts:1160-1161` / 根拠: design「振る舞い C」, decisions D6
      依存: なし
      AC: AC1
- [x] T10: server: フラグキーでも欄を書く。**ただし施錠中は書かない**（SysReq の逃げ道を守る）
      対象: `packages/server/src/ws-handler.ts:1031-1043` / 根拠: design「振る舞い C」, decisions D6, 既存の意図は同 `:1031-1034`
      依存: T9
      AC: AC1
- [x] T11: tn5250 の回帰テストを足す（積荷の読み飛ばし 4 通り・退避項目の往復・opcode・`writeCell`）
      対象: `packages/tn5250/test/save-screen.test.ts` `save-partial-screen.test.ts`（既存を書き替え）＋ 新規 / 根拠: design「テスト方針」
      依存: T4, T5, T7, T8
      AC: AC8
- [x] T12: server / web-ui の回帰テストを足す（フラグキーの同期・施錠中は同期しない・送信が変わらない）
      対象: `packages/server/test/` `packages/web-ui/test/`（新規） / 根拠: design「テスト方針」
      依存: T10
      AC: AC8
- [x] T13: **【test 工程で消化】** 実機で Attn→F12 の A/B。打鍵・MDT・カーソルが ACS と一致することを示す
      対象: `scripts/acs-probe.mjs` ＋ `scripts/acs-probe/attn-restore.txt`（ACS 側の基準線は research F11）/ 根拠: design「受け入れ基準との対応 AC1・AC2」
      依存: T4, T10
      AC: AC1, AC2
- [x] T14: **【test 工程で消化】** `scripts/tap-proxy.mjs` で当 PJ のワイヤを同期の前後に採り、送信バイト列が変わらないことを示す
      対象: `scripts/tap-proxy.mjs` / 根拠: research F17, decisions D9
      依存: T10
      AC: AC11
- [x] T15: **【test 工程で消化】** DSM で `0x62` / `0x66` / `0x6A` を実機に出させ、ACS の応答と突き合わせて形式を決着させる
      対象: `scripts/build-dscmd.mjs` `scripts/diag-5250-commands.mjs` `scripts/host-src/dscmd.c` / 根拠: design「振る舞い E」, decisions D5（実測に置き換える）
      依存: T8
      AC: AC5
- [x] T16: **【test 工程で消化】** 既存経路の非回帰を実機で確かめる（SEU F1→F12・PDM F1・QSH の SAVE PARTIAL・窓の往復）。opcode 変更後の往復もここで見る
      対象: 未特定（実機操作。`scripts/README.md`「検証に使う実機」）/ 根拠: design「受け入れ基準との対応 AC7・AC10」
      依存: T4, T7
      AC: AC7, AC10
- [x] T17: **【test 工程で消化】** `CAnn` を申告した画面で、Attn→F12 の往復後に F12 が欄データを送らないことを実機で確かめる
      対象: 未特定（`KEYDSPF` 相当。`scripts/README.md`「AID キーと欄データ（CA / CF）」）/ 根拠: design「受け入れ基準との対応 AC4」, research F8（`aidNoDataMask`）
      依存: T1, T4
      AC: AC4
- [ ] T18: **【deliver で消化】** 片付けと点検（実機の DSM 資材・scratchpad の秘密・`git status`・ACS 由来物が入っていないこと）
      対象: 未特定 / 根拠: requirements「非機能要件」, `AGENTS.md`「セキュリティ」
      依存: T15
      AC: AC9
