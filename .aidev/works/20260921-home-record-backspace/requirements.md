# 要件: Home を ACS と同じにし、Record Backspace と「欄データを載せない AID」を揃える

## 背景 / 課題
- 台帳「【まとめ】キー編集の細部が ACS と違う」の Home（中・**要判断**）と、低の「Clear / Help / Print / PA で欄データを送る」「未対応の機能: Record Backspace」。
  方針は利用者の判断「ACS に合わせて」（2026-09-21）。
- ACS の Home は画面のホーム位置（IC、無ければ先頭の非バイパス欄）へ移り、既にそこなら Record Backspace（AID 0xF8）を送る（`PS5250.processHome`）。
  当 PJ は欄の中なら欄の先頭、欄の外なら先頭の入力欄へ移るだけで、Record Backspace は送れなかった。
- ACS は Clear・Help・Print・Record Backspace で欄データを載せない（`DS5250.sendAid`）。当 PJ は MDT の欄を載せていた。

## 目的 / ゴール
- Home・Help・Clear・Print で、ホストが受け取るものとカーソルの行き先が ACS と同じになっている状態。

## ユーザーストーリー
- US1: 5250 の利用者として、Home で ACS と同じ位置へ行き、ホーム位置での Home が Record Backspace として働いてほしい。なぜなら、
  Record Backspace を使うアプリ（前のレコードへ戻る）が当 PJ では操作できないから。（受け入れ: AC1, AC2）
- US2: Help・Clear・Print を押したとき、打ちかけの欄がホストへ送られないでほしい。なぜなら、ACS では送られない値がホストに届くと
  アプリの振る舞いが変わりうるから。（受け入れ: AC3）

## スコープ
### 対象
- コア: `AidKey` の `RecordBackspace`・欄データを載せない AID・スナップショットのホーム位置。サーバーのスキーマ・MCP・キー設定の一覧。
- web-ui: ペインの Home、ScreenGrid の欄内 Home の撤去、送信の合流点の検査（0020 等）から Record Backspace を外す。
### 対象外
- PA1〜3（当 PJ は PA キーを送れない。台帳に残る）。End（ACS の既定は Erase EOF。別の項目）。

## 完了条件 (受け入れ基準)
- [ ] AC1: Home はホーム位置（IC → 先頭の非バイパス欄 → 1 行 1 桁）へ移る。欄の途中からでも欄の先頭ではなくホーム位置へ（実機の ACS: 7,22 → 3,20）。
- [ ] AC2: 既にホーム位置なら Record Backspace（0xF8）を送る。0020・ME・MF の検査はしない（ACS は 248 を外す）。Home で出た欄は「出た」扱い。
- [ ] AC3: Clear・Help・Print・Record Backspace はカーソルと AID だけを送る（READ MDT でも READ INPUT FIELDS でも）。実機の ACS のワイヤと同じ形。
- [ ] AC4: 各判定を外すとテストが落ちる（`verify-by-mutation`）。
