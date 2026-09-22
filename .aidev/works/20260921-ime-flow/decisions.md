# 決定記録

## D1: IME 確定の余りは、満杯で次の欄へ移ったときだけ次の欄の先頭から流す
- 原典（R11 (q)）: ACS は確定した字を 1 字ずつ打鍵として処理する（打鍵は満杯で次の入力欄へ自動送り）。~~ACS の GUI 層の IME 確定は headless のコアでは測れないので未測定~~ → 節目 11 の独立点検（B-N6）で、
  デコンパイル済みソース `ScreenTextDBCSJava2.inputMethodTextChanged`（`scratchpad/r11/cfr/.../DBCS/ScreenTextDBCSJava2.java:456-`）を直読して確認した:
  確定した字を 1 字ずつ `screen.sendKeys(new SendKeyEvent(this, new String(new char[]{c2}), null))` で流す（合成用の 2 字組は `CodePage.ComposeChar` で 1 字にまとめてから、
  サロゲートペアは 2 字まとめて送る。当 PJ の IME 経路にこの合成・置換は無い——未対応。日本語コードページの確定した `~` を U+203E へ置き換える処理もある。
  実機で測れるのは headless のコアだけだが、GUI 層は原典を読めば確定できる。AGENTS.md 判断の原則 1「原典を読む」）。打鍵の自動送りは実機で測定済み。
- 決定: `commitInto` が入りきらない余りを返し、`advanceIfFull` の `field-full` でペインがフォーカスを次の欄へ移したときだけ、`flowToNextField` が次の欄の 0 桁から続ける（最大 16 欄）。
  フォーカスが移らない（FER・自動 Enter・1 欄・保護欄）ときは捨てる（ACS も自動送りが起きなければ以降が入らない）。挿入で入らないときは従来どおり 0012。
- ~~余りを捨てる~~（`onCompositionEnd` の `break`）を破棄した。

## D2: 測っていないもの（未確認）
- ~~ACS の GUI 層の IME 確定が実際に 1 字ずつの打鍵として流れるか~~ → 上の D1 で原典を読んで確認した。巡回（最後の欄から最初の欄）へ流す規則（当 PJ は打鍵と同じくペインの自動送りに従う）は未確認のまま。実ブラウザの IME の確定の順序（jsdom は compositionend まで）。
