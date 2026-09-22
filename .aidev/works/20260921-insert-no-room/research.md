# 調査: 挿入モードの余地（ACS）

## 調査の問い
- Q1: ACS は挿入の余地をどう数え、足りないとき何をするか。
- Q2: 行をまたぐ欄・継続欄・符号付き数値欄ではどうか。
- Q3: 当 PJ はどこで切り詰めているか。

## 判明した事実
- F1（原典）: `PS5250.processCharKeyStroke` の挿入の枝 → `insertChar`。型の検査（`checkSBCSField`）のあと
  `reserveRoomForInsert(欄, 最終桁, 要る桁数, カーソル)`。最終桁は符号付き数値なら符号桁の手前。
  カーソルが欄の最終桁（`getEndPos`＝開始＋長さ−1）なら即「余地なし」。そうでなければ最終桁からカーソルまで**末尾に続く空白**
  （NUL・空白・全角空白）を数え、要る桁数に満たなければ余地なし。余地なしは戻り値 `0x80000012` → `setErrorCode((short)…)`＝0012。
- F2（原典）: 挿入のあとのカーソル: 最終桁で自動実行（AUTO_ENTER）なら Enter、Field Exit 必須なら `fieldExited` を立てる（**カーソルは
  それでも 1 桁進む**——上書きの枝と違う）。継続欄は区間の終わりで次の区間の先頭へ。上書きと違い次の欄へは送らない。
- F3（実機・ACS のコア・2 回。`scripts/acs-probe/insert-no-room.txt`）: メインメニューのコマンド行（20,7 から 153 桁）で
  I1 `ABC` の先頭に挿入 → `XABC` ／ I2 空の欄の最終桁（21,79）→ エラー（inhibit=5）・値不変 ／ I3 20 行を埋めて 21 行 1 字 →
  先頭に挿入で 21 行が `BC`（**行をまたいで欄全体で押し出す**）／ I4 途中に空白・末尾が埋まっている → エラー ／ I5 満杯 → エラー ／
  6S0（7 桁）で I6 Field− 後の `    12-` の先頭 → エラー ／ I7 左詰め `12` の先頭 → `912`、符号桁は動かない。
  エラーに入ると挿入モードが解ける（既知。`20260921-operator-error-mode`）。
- F4（原典の読みを実測で覆した）: `reserveRoomForContField` は区間ごとに `--endPos` から数え・ずらすので、字面では区間の最終桁が
  数えられず字が重複・消失しうると読めた。**実機では起きない**（F5）。
- F5（実機・ACS のコア・`PROBE_ENPTUI=true`。`scripts/acs-probe/insert-no-room-continued.txt`）: DTMPGM の D8U（4/2/2 の 3 区間）で
  `1234/56/..` の先頭に 9 → `9123/45/6.`、`1234/../..` → `9123/4./..`、`1234/56/7.` → `9123/45/67`（**最終区間の最終桁も数える**）、
  満杯 → エラー、空の欄の最終区間の最終桁 → エラー。＝全区間をつないだ 1 つの欄として F1 と同じ規則。
  - **拡張 5250 を申告しないと、ホストは欄を割らずに 1 つの 10 桁の欄として送る**（区切りの `/` も上書きできた）。HOD の既定は
    `ENPTUI=false` だが、利用者の ACS は有効（タップで採った Query Reply が `DS5250` の `bENPTUI` 真の値 0x0F・0xC8）。
    プローブに `PROBE_ENPTUI` を足した。
- F6（当 PJ）: SBCS の打鍵は `ScreenGrid.vue` の印字文字の枝で `typeChar`（`fieldEdit.ts:29-43`）→ 挿入は splice して
  `chars.length = len` で切り詰め。符号桁も押し出す。IME 確定（`onCompositionEnd`）も同じ `typeChar`。継続欄も区間だけで切り詰める。
  DBCS 欄（`dbcsType`）は論理値＋バイト予算で、越えると `undefined` → 黙って拒否（値は変えない。通知が無い）。論理値のモデルは
  最終桁という位置を持たないので、F1 の「最終桁にカーソル」は写せない。貼り付けは `insertInto` で全体の余地を見て `MSG_NO_ROOM`。

## 実装アンカー
- A1: 打鍵（`ScreenGrid.vue` の `onInputKeydown` 印字文字の枝）。A2: IME 確定（`onCompositionEnd`）。
- A3: 継続欄の合成バッファ（`editAcrossContinued`）。A4: DBCS 欄の印字文字（`onDbcsKeydown`）。
- A5: 純関数（`composables/fieldEdit.ts`）。通知の定数 `MSG_NO_ROOM`（`opMessages.ts`。既に操作員エラー）。

## design への申し送り
- 規則は純関数 1 つ（余地の判定＋押し出し）に集め、打鍵・IME・継続欄から呼ぶ。
