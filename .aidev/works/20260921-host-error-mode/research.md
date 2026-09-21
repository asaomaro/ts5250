# 調査: ホストのエラー（WRITE ERROR CODE）でも ACS はエラー状態に入る

## 判明した事実

### F1: 原典（`DS5250.processWriteErrorCode`）
- `PS5250.setErrorMode(true)` を呼ぶ。条件付きで `initKeyboard()`（挿入モードを解く）。
- メッセージ行の位置を退避し（`saveMsgLinePosition`）、本文を WTD と同じ経路（`processWriteToDisplay`）でメッセージ行へ書く。
- エラーを抜ける（`clearErrorMode`）と `restoreMsgLinePosition(false)` でメッセージ行を元に戻す。

### F2: 実機（ACS。`scripts/acs-probe/window-error.txt`・試験画面 ULKPGM）
| 場面 | 届いたコマンド（当 PJ で採取） | ACS |
|---|---|---|
| 全画面の RANGE(1 5) に 9 | WTD・**WRITE ERROR CODE（0x21）**・READ | **inhibit=5（エラー状態）**・最下行にメッセージ・**文字 3 は拒否**・**左矢印で抜けると最下行が消える** |
| 窓の中の RANGE(1 5) に 9 | WTD・WTD・READ（**0x22 ではない**） | inhibit=0・メッセージは窓の中（12 行目）・文字は入る・矢印でもメッセージは残る（ただの WTD） |
| 全画面の WEC・挿入モード ON で | 同上 | **挿入モードが解ける**（insert=false）。**Tab で抜けると最下行が消える** |
| コマンド行の未知コマンド・プロンプターの不正値 | WTD（WEC ではない） | エラー状態に入らない（inhibit=0・文字も入る） |

### F3: 当 PJ（`scripts/verify-host-error.mjs`）
- 全画面: `systemMessage` に本文が載り、最下行に重ねて出す。**エラー状態に入らない**（文字が入る）・挿入モードも解かない・
  抜ける操作でメッセージを消さない（ホストがメッセージ行を書き替えるまで残る）。
- 窓: WTD なので窓の中（12 行目）に出る。**ACS と同じ**。

## 結論
- 窓の中のエラーは、実機では WRITE ERROR CODE TO WINDOW（0x22）で来なかった（WTD）ので、当 PJ との差は無い。0x22 は未観測のまま。
- 全画面の WRITE ERROR CODE で、①（操作員エラー）と同じ規則のエラー状態に入り、挿入モードを解き、抜けたらメッセージを消す。
