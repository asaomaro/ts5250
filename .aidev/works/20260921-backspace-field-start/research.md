# 調査: ACS の欄の先頭の Backspace

## 判明した事実
- F1（原典）: `PS5250.processBackspace` は 1 桁左で `processDeleteChar` を試み、失敗したらカーソルを戻す。欄の先頭では 1 桁左が属性の桁（欄の外）なので失敗し、
  `processDeleteChar` がエラー 5（0005）を立てる。行をまたぐ欄の区切りの先頭なら前の区切りの末尾を消す。DBCS の欄は SO の前が属性の桁で 0101。
- F2（実機・ACS のコア・PUB400 のサインオン画面）: 2 つ目の欄の先頭で Backspace → cursor そのまま・inhibit=5、続けて打った AB も受け付けない。
  1 つ目の欄の先頭でも同じ。Reset の後、1 文字打ってからの Backspace は普通に消えて戻る（`scripts/acs-probe/backspace-field-start.txt`）。
- F3（当 PJ）: `ScreenGrid.vue` は欄の先頭で `field-prev` を出し、`EmulatorPane.vue` の `onFieldPrev` が前の欄の末尾へ移す（GNU tn5250 `kf_backspace`）。
