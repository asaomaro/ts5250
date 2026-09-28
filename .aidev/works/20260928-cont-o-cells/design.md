# 仕様: 継続欄の O の編集を ACS と同じセルの並びで行う

## 概要
O 欄（継続でない）のセルの編集（#443）を、継続した O 欄では**鎖全体**の操作に広げる。区間ごとのセルの配列（`OCell[][]`）とカーソル
`{ seg, c }` を受けて、ACS の手順（research F1）どおりに書き換える純関数を `composables/oChainCells.ts` に置き、`ScreenGrid.vue` の
DBCS の打鍵・Backspace・Delete から呼ぶ。死んだ桁は値の中の印（生バイトのセンチネル 0x00）で持つ。core は死んだ桁を NUL のセルに置き、
送信で区間の境目の SI|SO を詰める。

## 設計方針
- **鎖の操作は区間の配列の上で行う**。平らな 1 本の配列にしない——ACS の手順は区間の終わり（SI で閉じる・SO を送る・死んだ桁）を区間ごとに判定する
- **挿入の詰め直しは「トークン列」を作ってから区間へ書く**（ACS の B バッファ）。トークンはセルの種類（SO・SI・前半・後半・半角）を持つ。
  前半・後半の判定は ACS のようにバイトの交互ではなく**トークンの種類**で行う（並びの中の割れた組でも前後を取り違えない。整った並びでは同じ結果）
- **カーソル**: 挿入は「入れた字の次のセル」（字のトークンに印を付けて、書いた後に探す）。そこが区間の最後のセルの SI なら飛ばし、区間の外なら
  次の区間の頭へ。ACS のカーソルの数え方（詰め物の数だけ進めて adv を足す）と、測った 7 通り（C01〜C04・C11・C12・C09）で同じ結果になる。
  Delete・Backspace はカーソルの位置の元のトークン。上書きの区間送りは次の区間での上書きの結果
- **死んだ桁の印**: `DEAD_MARK = rawSentinel(0x00)`。`hasShiftMarks`（明示の並びの判定）に含める——半角だけの区間の後ろに死んだ桁が残ることがある（SO を送った区間）。
  表示は空白 1 桁（`viewChar` がセンチネルを空白にする既存の規則）
- 退けた案: 死んだ桁を画面の側の別の表（欄→桁の集合）に持つ——値の往復（`props.edits`）と別に同期が要り、ホストの書き直しで消す契機も要る。値の中の印なら往復で残る

## 対象範囲
- 新規 `packages/web-ui/src/composables/oChainCells.ts`
- `packages/web-ui/src/composables/oFieldCells.ts`（死んだ桁のセル・Backspace の対象の桁を外へ出す）
- `packages/web-ui/src/composables/fieldValidate.ts`（`DEAD_MARK`）
- `packages/web-ui/src/components/ScreenGrid.vue`（継続した O 欄の経路）
- `packages/tn5250/src/screen/buffer.ts`（`setFieldValue` / `setFieldCells` の死んだ桁）
- `packages/tn5250/src/protocol/read-response.ts`（`rawDbcsSendValue` の SI|SO の詰め・構造の無い区間）

## 依拠する既存の事実
- 継続欄の区間の並びは `continuedRunOf`（`ScreenGrid.vue:2969` → `composables/continuedRun.ts`）
- 他の区間への書き込みは `commitFieldValueDirect`（`ScreenGrid.vue:2992`）、フォーカスの移し方は `editAcrossContinued` の末尾（`:3057`〜`:3070`）
- O 欄の値の印の読みは `logicalFromCells`（`:1834`）・`oExplicit`（`:1827`）で、どちらも `isOCells`（継続を外す）で絞っている
- Erase EOF・Field Exit は `eraseToEndDbcs`（`:2263`）がカーソルの区間を、`fillFollowingSegments`（`:3007`）が続く区間を消す——ACS `eraseToEOF_Work` と同じ分け方
- core の置き場は `setFieldValue` が SO/SI の印を見て `setFieldCells` へ（`buffer.ts:1305`〜`:1313`）。送信は `rawDbcsSendValue`（`read-response.ts:181`）
- Field− の継続欄の拒否は既存（`ScreenGrid.vue:2711`）

## インターフェース / データ構造
```ts
// oFieldCells.ts
export interface OCell { k: OCellKind; ch: string; dead?: true }   // dead は k:"sb" のときだけ
export function backspaceTarget(cells, c): number | { error: 0x05 | 0x65 }
// oChainCells.ts
export interface ChainPos { seg: number; c: number }
export type ChainResult = { segs: OCell[][]; cursor: ChainPos } | { error: 0x05 | 0x12 | 0x65 } | { noop: true };
export function chainInsert(segs, pos, ch): ChainResult
export function chainOverwrite(segs, pos, ch): ChainResult
export function chainDelete(segs, pos): ChainResult
export function chainBackspace(segs, pos): ChainResult
export function reflow(segs, pos, ops): { segs, cursorToken } | undefined   // 内部
// fieldValidate.ts
export const DEAD_MARK = rawSentinel(0x00); export const isDeadMark
```

## 振る舞いの詳細
- **挿入**（`chainInsert`）: 操作列はカーソルのセルの種類で決める（#443 の `insert` と同じ表）。表に無い（並びの外の後半など）は 0x12。
  トークン列 = 操作列 ＋ カーソルから鎖の終わりのセル（死んだ桁は捨てる。SO の操作でカーソルが SO なら、SI の操作でカーソルが SI なら、その既存を食う）。
  SI の直後の SO を組ごと取り除く（繰り返し）。長さ = 最後の空き（半角空白）でないトークンまで。余地 = カーソルから区間の終わり＋後続の区間の全長。
  余地 < 長さなら 0x12。収まれば、カーソルから区間の終わり・後続の区間を空にしてから区間ごとに書く（research F1 の規則。SO を送った残りと SI の後ろの 1 桁は死んだ桁）
- **上書き**（`chainOverwrite`）: 区間のセルで #443 の `overwrite`。エラー（区間の終わりの行）で次の区間があれば、カーソルの次から区間の終わりを死んだ桁にし、
  次の区間の頭で上書きをやり直す（その区間でも足りなければさらに次へ）。最後の区間ならそのエラー。成功してカーソルが区間の外なら次の区間の頭へ
- **Delete**（`chainDelete`）: k = SO+SI・SI+SO・全角・死んだ桁は 2、単独の SO/SI は 0x65、ほかは 1。区間ごとに左へ k 詰め、区間の最後の k 桁は次の区間の頭の k 桁
  （ACS と同じく、カーソルが区間の最後の k 桁の中でも最後の k 桁を次の区間の頭で上書きする）、最終区間の最後の k 桁は空き。そのあと操作無しの詰め直し（収まらなければ詰めたまま）
- **Backspace**（`chainBackspace`）: カーソルが区間の頭（区間 > 0）なら前の区間の最後の桁で Delete。ほかは区間の中で #443 と同じ対象の桁（`backspaceTarget`）で Delete。
  鎖の頭は 0x05
- **Erase EOF・Field Exit・Field+**: 既存の分け方のまま（カーソルの区間は `eraseToEnd`、続く区間は空）。`eraseToEndDbcs` の O 欄の判定を継続欄にも広げる
- **送信**: O・J の鎖で、区間をつなぐとき、ここまでの最後が SI で次の区間の頭が SO なら両方を落とす（最終区間へ詰めたときは末尾に空きを 2 つ足す——ACS と同じく長さを保つ）。
  鎖の区間のどれかが DBCS の構造を持てば、構造の無い区間も桁ごとに生で読む
- **死んだ桁**: core の `setFieldValue` は、O 欄の値に死んだ桁の印があれば `setFieldCells` へ。`setFieldCells` は並びの外の印 0x00 を空のセル（NUL）にする

## ドメイン固有の考慮
- ACS の原典は事実（手順・定数）だけを持ち帰り、コードとコメントは自分の言葉で書く
- 空白（0x40）と NUL は当 PJ の O 欄の値では区別しない（C09・C10 の末尾の 0x40 は送らない）——台帳に差として残す
- 並びの前半が区間の最後の桁に来る場合（ACS が守っていない）は ACS の手順どおりに書く（未測定と注記）

## エラー処理 / 異常系
- 0x12（余地なし・表に無い位置）・0x05（最終区間の終わりの全角）・0x65（単独の SO/SI・最終区間の終わりの SI の上の半角）: 値もカーソルも変えず操作員メッセージ
- 単独の SO/SI での Delete（0x65）: ACS はエラーでも詰め直しを回すが、当 PJ は値を変えない（未測定。decisions に残す）

## 受け入れ基準との対応
- AC1: `chainInsert` の単体テストで C01〜C04・C09〜C12 の区間の値を作り、core の単体テストでその値から READ MDT のバイト列を組んで ACS の測定と比べる。入力は research F2 の表
- AC2: `chainOverwrite`・`chainDelete`・`chainBackspace`・Erase（`eraseToEnd`）で C05〜C08 を同じく
- AC3: 同じ単体テストでカーソル（区間・桁）を F2 の表と比べる
- AC4: core の単体テスト（`read-response` の鎖の送信）で C12 の詰めと C02 の死んだ桁
- AC5: `chainInsert` の単体テストで余地を超える挿入が 0x12
- AC6: `scripts/verify-browser-cont-o.mjs` を実機で流し、ホストのログ（CONTOX の `[C01]`〜`[C12]`）を F2 と比べる（C09・C10 は末尾の 0x40 を除いて比べる）
- AC7: 既存の web-ui・tn5250 の単体テスト
