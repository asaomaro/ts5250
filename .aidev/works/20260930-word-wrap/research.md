# 調査: 語送りの欄の ACS の挙動

## 調査の問い
- Q1: ACS は語送りの欄をどう組むか（手順・NUL の使い方・カーソル）
- Q2: ホストへ届く欄はどうなるか（READ MDT と ALT）

## 判明した事実
- F1: 手順は `PS5250.processWordWrap`（`acs/out/…/tn5250/PS5250.java:5082`）: 編集位置から語の頭へ（`determineWrapStart`）→ 語の頭から後ろの NUL を整理（`cleanCopyOfNulls`: 末尾の NUL を捨て、空白の左の NUL を捨て、字に挟まれた NUL の連なりは 1 つに畳む）→ 行ごとに、行末の桁が空白でも NUL でもなければ語の頭まで戻って NUL を挟んで押し出す（`performWrapOnCopy`。1 行より長い語は行末で切る。最後の行は送らない）→ 収まるときだけ欄を消して書く（`doesWrapFit`）。カーソルはカーソルより前に入った NUL の数だけ進む。
- F2: 呼び出しは打鍵（`processCharKeyStroke` の末尾。欄の最終桁を打って次の欄へ移ったときは掛けない）・削除（`processDeleteChar`）・貼り付け。DBCS の欄は対象外（`processWordWrap` の頭）。
- F3: 印は `Field5250.java:186`（FCW 0x8680）。行に収まる欄では下ろす（`Field5250.java:779`〜）。MF・自己点検・符号付き・右寄せ・I/O・数字のみ・数値のみ・Dup と組む欄は不成立（当 PJ の `fieldAddFailure` が既に同じ）。
- F4: 実機（DSM の `WRAPFLD`。(5,70) から 30 桁）の ACS のコアで W1〜W8 を測った（`scripts/acs-probe/word-wrap.txt`）。ホストが受け取った欄: W1 `aaa bbbb ` + `00 00` ｜ `cccc dddd`（カーソル 6,10）、W3（Delete×2）`aabbbb ` + NUL 4、W4（挿入）`aaaXXXX ` + NUL 3、W5（空白なしの長い語）NUL なし、W6（Backspace×6）、W7（READ MDT。途中の NUL が 40）、W8（空白続き。NUL なし）。測定を 2 回取った（要約が失われた後の再測定でも同じバイト列）。
- F5: 当 PJ の core は空きのセルを `null`（NUL）で持ち、送信は `cellAt === null` で NUL を見分け（`read-response.ts:sendValue`）、READ MDT で途中の NUL を 0x40、ALT で 00 にする既存の道がある。値を運ぶ `fieldValue` が NUL と空白を区別しない点だけが欠けていた。

## 実装アンカー
- A1: FCW の解釈（`packages/tn5250/src/protocol/wtd-applier.ts` `cont.wrap`）
- A2: 欄の値（`packages/tn5250/src/screen/buffer.ts` `fieldValue` / `setFieldValue`）
- A3: 編集（`packages/web-ui/src/components/ScreenGrid.vue` `onInputKeydown` / `beginEdit` / `sync`）、`packages/web-ui/src/composables/fieldEdit.ts`

## 実装時の注意
- ACS のコード・コメントは写さない（手順の事実だけを自分の言葉で）
