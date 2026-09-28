# 調査: 継続欄の O の編集（ACS の原典と実機の測定）

## 調査の問い
- Q1: ACS は継続した O 欄の各操作をどう行うか（原典）
- Q2: 実機の ACS のコアで、ホストが受け取るバイト列は原典の読みどおりか（前回の画面の読みと食い違った B・D を含む）
- Q3: 当 PJ の現状の経路はどこか

## 判明した事実
- F1（原典。CFR のデコンパイル＋ `javap -c` の照合。事実だけの抜き書きは scratchpad の `acs-cont-o-rules.md`）:
  - 挿入は `PS5250.insertChar` → `processCharWithDBCSOpenContField`。カーソルの桁の操作列（全角: 半角の上 SO DB SI・SO の上 SO DB・SI/並びの中 DB、
    半角: 半角/SO の上 字・SI の上 SI 字・並びの中 SI 字 SO）を先に出し、カーソルから鎖の終わりまでのバイトを続ける。**SO の上の SO・SI の上の SI は既存を食う**。
    死んだ桁（DBCSPlane 8）は落とし、NUL・空白は普通のバイトとして残す。`mergeDBCSString` が SI の直後の SO を組ごと取り除く。
  - 余地 = カーソルから区間の終わり＋後続の区間の全長（死んだ桁込み）。中身の長さ = 最後の非 0 バイトまで（**末尾の NUL だけが空き・末尾の 0x40 は中身**）。
    余地 < 長さなら 0x12。収まれば `eraseToEOF` してから区間ごとに書く（`checkWordsFitDBCSOpenContField`）:
    SO が区間の最後の 3 桁以内に来たら残りを死んだ桁にして次の区間へ（SO は次の区間の頭）／並びの前半が最後の 2 桁目に来たら SI＋死んだ桁／
    後半が残り 3 桁目で次が SI でなければ SI＋死んだ桁／後半が残り 2 桁目で次が SI でなければ最後の桁に SI。いずれも次の区間は SO から始まる。
    **語の区切りを見る処理は無い**（名前に反して 1 バイトずつ）。
  - 上書きは `inputChar`。区間の終わりで足りない行（`E` の行）は、鎖が続いていれば `insertDbDead(cursor, segEnd)` でカーソルの次から区間の終わりを死んだ桁にし、
    次の区間の頭で `inputChar` を打ち直す。最終区間は従来のエラー（全角 0x05・SI の上の半角 0x65）。
  - Delete は `deleteCharInContField`: 鎖全体を k（SO+SI・SI+SO・全角・**死んだ桁**は 2、他は 1、単独の SO/SI は 0x65）左へ詰め、最終区間の末尾 k 桁を NUL。
    その後、エラーでも `processCharWithDBCSOpenContField` を操作無しで回す（死んだ桁を捨て、詰め直す）。
  - Backspace は、カーソルが区間の頭なら前の区間の最後の桁を対象にする（`processBackspace`）。
  - Erase EOF は、カーソルから区間の終わり＋後続の区間を全部消す。カーソルが SI の上か並びの中なら SI を置く（`eraseToEOF_Work`）。
  - 送信は `FFT5250.getFieldContents`: 区間を連結するとき、ここまでの最後が SI で次の区間の頭が SO なら両方を落とす。
    最終区間へ詰めたときは長さが保たれ末尾に 00 00 が 2 つ残る（READ MDT では末尾の NUL として落ちる）。
  - 語送り（0x8680）の欄だけ、この後に `processWordWrap` が回る（対象外）。
- F2（実機。2026-09-28・社内機・ACS のコア。DSM の CONTOX・`scripts/acs-probe/cont-o-edit.txt`）。画面は先頭 `SO い え SI X NUL`・中間 `Y Z NUL×6`・最終 空。
  ホストの READ MDT のバイト（欄データ）とカーソル:

  | 巡 | 操作 | 欄データ | カーソル |
  |---|---|---|---|
  | C01 | SI(5,15) に全角 う を挿入 | `0e4482448444830fe740e8e9` | 6,10 |
  | C02 | X(5,16) に全角 え を挿入 | `0e448244840f40400e44840fe740e8e9` | 6,13 |
  | C03 | 中間の頭 Y(6,10) に全角 お を挿入 | `0e448244840fe7400e44850fe8e9` | 6,13 |
  | C04 | い(5,11) に半角 Q を挿入 | `0e0fd80e44820f400e44840fe740e8e9` | 5,13 |
  | C05 | X(5,16) に全角 か を上書き | `0e448244840fe7400e44860f` | 6,13 |
  | C06 | い(5,11) で Delete | `0e44840fe740e8e9` | 5,11 |
  | C07 | 中間の頭(6,10) で Backspace | `0e448244840fe7e8e9` | 5,17 |
  | C08 | え(5,13) で Erase EOF | `0e44820f` | 5,13 |
  | C09 | （空白埋め）C01 と同じ | C01 ＋ `404040404040` | 6,10 |
  | C10 | （空白埋め）C02 と同じ | C02 ＋ `404040404040` | 6,13 |
  | C11 | SO(5,10) に全角 き を挿入 | `0e4487448244840fe740e8e9` | 5,13 |
  | C12 | え(5,13) に き く を続けて挿入 | `0e44824487448844840fe740e8e9` | 6,10 |

  12 巡とも F1 の読みどおり（C02 は SO が区間の最後の 2 桁に来て 5,16・5,17 が死んだ桁→途中の NUL として 0x40、C04 は受け付けて並びを割る、
  C12 は先頭の区間の最後の桁が SI・中間の頭が SO で詰まる）。**前回の画面の読みの「D は拒否（施錠 5）」は誤り**（今回は受け付け、施錠なし）。
  C09・C10 は空白が中身として最終区間まで押し出された（末尾の `40` が 6 つ）。
- F3（当 PJ の現状）: `ScreenGrid.vue` の `isOCells` は継続した O 欄を外しており（`packages/web-ui/src/components/ScreenGrid.vue:2157`）、継続欄は
  `editAcrossContinued`（論理値の合成バッファ。`:3039`）で挿入だけを鎖で扱い、Backspace・Delete は DBCS を対象外にしている（`:3173`・`:3200`）。
  値の読みは `logicalFromCells`（`:1834`）が O 欄（継続でない）だけ印を付ける。
- F4（core）: `setFieldCells`（`packages/tn5250/src/screen/buffer.ts:1251`）は印入りの値を構造どおりのセルへ置く。区間ごとに呼ばれる。
  送信は `rawDbcsSendValue`（`packages/tn5250/src/protocol/read-response.ts:181`）が区間の `dbcsRawCells` を連結する。SI|SO の詰めは無い。
  DBCS の構造を持たない区間（例: 中間の `X NUL Y Z`）があると `undefined` を返し、`sendValue` の桁ごとの経路へ落ちる。

## 影響範囲
- web-ui: `oFieldCells.ts`（鎖の操作を足す）・`fieldValidate.ts`（死んだ桁の印）・`ScreenGrid.vue`（継続した O 欄の打鍵・Delete・Backspace・消去の経路）
- core: `buffer.ts` の `setFieldCells`（死んだ桁の印を NUL に）・`read-response.ts`（SI|SO の詰め）

## 実現性 / リスク
- 死んだ桁は ACS では DBCSPlane の印だけで、バイトは NUL。当 PJ の値に印（生バイトのセンチネル 0x00）で持てば、区間の値の往復でも残る
  （`props.edits` が編集の値を持つ間）。ホストが書き直せば消える——ACS も書き直しで DBCSPlane を作り直す。
- 空白と NUL の区別は当 PJ の O 欄の値に無い。C09・C10 の末尾の 0x40 は当 PJ では送らない（差として残す）。

## 実装アンカー
- A1: 鎖の区間の並び（`ScreenGrid.vue` の `continuedRunOf`・`composables/continuedRun.ts`）
- A2: O 欄の操作の入口（`ScreenGrid.vue` の `oApply`・`isOCells` の呼び出し 8 か所）
- A3: 印（`fieldValidate.ts:169` の `SO_MARK`/`SI_MARK`/`hasShiftMarks`）
- A4: core の置き場と送信（`buffer.ts:1251` `setFieldCells`・`read-response.ts:181` `rawDbcsSendValue`・`:105` `sendValue`）

## 実装時の注意
- 区間の値は区間ごとに `emit("edit", index, value)` で出す（`commitFieldValueDirect`）。フォーカスはカーソルの着いた区間へ移す
- 並びの前半が区間の最後の桁に来る場合（原典が守っていない）は未測定。当 PJ は ACS の手順どおりに書く

## design への申し送り
- 死んだ桁の持ち方・鎖の操作の形（区間の配列とカーソル {区間, 桁}）
