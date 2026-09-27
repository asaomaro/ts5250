# 要件: キー編集の細部の残りを ACS と同じにする（Alt の ¢¬£・J 欄の Home・CSRINPONLY・PA1〜3・Test Request）

## 背景 / 課題
`.aidev/backlog/acs-parity.md` の【まとめ】キー編集の細部の残り: `¬ ¢ £` の Alt 入力、(e) J 欄がホーム位置のときの Home、(g) 未対応の機能（SOH 0x10 の入力欄だけ移動・PA キー）。
あわせて ACS の既定の割り当て（`AcsMapFunctions.MAP_5250`）で当 PJ に無かった Test Request（`A19 = [test]`）。

## 目的 / ゴール
これらのキーの動きと送るバイト列が実機の ACS と同じになっている状態。

## ユーザーストーリー
- US1: 5250 端末の利用者として、ACS と同じキーで ¢¬£ を打ち、PA キー・Test Request を送り、CSRINPONLY の画面で矢印が入力欄だけを動いてほしい。なぜなら ACS で使い慣れた操作がそのまま使えないと業務の画面で手が止まるから。（受け入れ: AC1〜AC4）

## スコープ
### 対象
- web-ui（既定の割り当て・文字の割当・Home・矢印）、core（PA1〜3・Test Request・SOH の 0x10）、server（キー名の表・HLLAPI のニーモニック）
### 対象外
- ACS の `C17 = [newline]`（Ctrl 単独で改行）: プローブ（ECL）では Java のキー処理を通せず測れない。Ctrl を押すたびに改行すると Ctrl の組み合わせのキーと衝突するので入れない（未確認）
- 【まとめ】の「実装しない・閉じてよい」に挙がったもの（(c)(i)(k)(m)(n)(o)）

## 完了条件 (受け入れ基準)
- [ ] AC1: Alt+@ で ¢・Alt+\ で ¬・Alt+- で £ を打つ（ACS の既定。割り当ては変えられる）
- [ ] AC2: ホーム位置が J 欄（SO の桁）なら Home は SO の次へ移り、Record Backspace を送らない（実機の ACS と同じ）
- [ ] AC3: SOH のフラグ 0x10 の画面で、矢印で入力欄の外へ出たら ACS と同じ位置へ寄せる（実機の ACS の 6 通り）
- [ ] AC4: PA1〜PA3 はカーソルと AID だけ、Test Request はヘッダのフラグ 0x02 だけを送る（実機の ACS と当 PJ の実機検証）
- [ ] AC5: 片付け
