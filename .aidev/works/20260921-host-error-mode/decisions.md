# 決定記録

## D1: 窓の中のエラーは直さない（実機で差が無かった）

- 台帳は「WRITE ERROR CODE TO WINDOW（0x22）を最下行に出す」差を挙げていた。実機（WINDOW キーワードの窓の中の RANGE 欄）では
  ホストは 0x22 ではなく **WTD で窓の中（12 行目）に書き**、ACS もエラー状態に入らなかった。当 PJ も窓の中に出しており差は無い。
- 0x22 は実機で観測できていない。来たら従来どおり最下行に出す（未確認のまま台帳に残す）。

## D2: 見分けは通し番号（文言ではない）

- 同じ文言のエラーが 2 回目に来ても入り直すため。プロセスで通しにして、画面バッファの作り直し（繋ぎ直し）でも重ならないようにした。

## D3: WEC での挿入モードの解除は、既存の「画面ごとに上書きへ戻す」監視と重なる

- WEC も新しい画面として届くので、`20260921-insert-mode-per-screen` の監視が先に上書きへ戻す。WEC の監視側の解除は
  外しても観測上は同じ（mutation H2 が生き残るのはこのため）。ACS が WEC で挿入モードを解く事実を明示するために残す。

## D4: エラー状態をペインからセッションへ移す（独立点検の後）

- 背景: 独立点検（must 2 件・should 1 件）——ペインがエラー状態と隠した番号を持っていたので、(a) 抜けずにタブを切り替えて戻る、
  (b) 裏のタブに WEC が届いてから切り替える、(c) 抜けた後にペインを作り直す、のどれでも「最下行にメッセージがあるのにエラーでない」
  「隠したのに戻る」になった。サーバーの再起動で番号が振り直されると、同じペインの新しいセッションで番号が重なる恐れもあった。
  ACS はセッションの窓ごとに `error_mode` を持つ。
- 決定: 隠した番号を `SessionState.hostErrorDismissedSeq` に持ち、エラー中かは「番号がある・隠した番号と違う」から**導く**
  （`hostErrorActive`）。操作員エラー（ペインの通知から入る）とは `inErrorMode` で合わせる。
- 影響: 挿入モードは WEC を載せた画面が届いた時点で `watch(snapshot)` が戻す（D3 のとおり、WEC 専用の監視は要らなくなった）。

## D5: CLEAR UNIT でエラー状態を抜ける（操作員エラーも）

- 背景: 独立点検（must）——WEC の後にサインオン画面（自動の繋ぎ直し・無操作のサインオフ）が来ても、最初の打鍵がメッセージも
  出ないまま拒否された。ACS は `DS5250.processClearUnit` と `processSaveScreen` で `PS5250.clearErrorMode()` を呼ぶ（javap で確認）。
- 決定: ホストのエラーは、コアが CLEAR UNIT・SAVE SCREEN で `systemMessage` を捨てるので D4 の導き方で自然に抜ける。
  操作員エラーは、スナップショットの `lastWrite.cleared` を見て抜ける。**同じレコードに CLEAR UNIT と WEC があるときは
  ホストのエラーを隠さない**（操作員エラーだけ抜ける）。SAVE SCREEN はスナップショットに印が無いので操作員エラー側は見ない（未対応）。

## D6: エラー中はローカル編集キーも拒否する（`20260921-operator-error-mode` D2 を破棄）

- 背景: ① D2 は「未測定のキー（Field Exit・Erase EOF・Dup ほか）は抜ける側に倒す」とした。独立点検が原典
  （`PS5250.keyDown` はエラー中に `ErEOF_Key` / `ErInp_Key` / `EraseField_Key` / `FldExit_Key` / `FldPlus_Key` / `FldMinus_Key` /
  `FldMark_Key` / `Dup_Key` を警告音だけで捨てる）を示し、実機の ACS でもどれも欄を変えずエラーのままだった
  （`scripts/acs-probe/field-exit-full.txt` の場合 F・H。`20260921-field-exit-required-types` research F10）。
- 決定: 割り当てがローカル編集キーなら拒否する（`localEditActionOf`）。① D2 は取り消し線で残した。
- 未対応: 画面のボタン（パレット）から押した編集キーは、押したクリックでエラーを抜けてから働く（クリックで抜けるのは ACS と同じ）。

## D7: 本文が空白だけの WEC でも番号を振る

- ACS `processWriteErrorCode` は本文を読む前に無条件で `setErrorMode(true)` とする（独立点検の nit）。`systemMessage` は空文字で載る。
  実際に届くかは未確認。
