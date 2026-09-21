# テスト結果: 既定のキー割り当てと End の行き先

## 実行したもの
- web-ui のキー操作に触れる 60 ファイル（`screen-grid*`・`pane-nav`・`keymap`・`keybindings`・`field-*`・`insert*`・`view-cycle`・`operator-error`・`acs-default-keys` ほか）— 866 passed / 0 failed。
  欄の編集に触れる 39 ファイル（End の変更のあと）— 508 passed / 0 failed。
  型検査（`vue-tsc --noEmit`。`tsconfig.json` と `tsconfig.test.json`）通過。lint（変更したファイル）通過。
- 実機: なし（ACS の GUI のキー割り当ては、GUI を使わない ACS のコアでは測れない。原典の表を正とした）

## 受け入れ基準ごとの判定
- AC1: pass — `DEFAULT_BINDINGS` の中身、End に割り当てが無いこと、キーハンドラーが Attn・SysReq・Clear・Print（`Pause` / `Cancel`）・Help を送ること。
- AC2: pass — ペインで Shift+Insert → Dup（挿入モードは「上書き」のまま）、Insert → 挿入、End に Erase EOF を割り当てると消える、欄の中の Esc → Attn。
  DBCS 欄でも Shift+Insert・割り当てのある End を欄が処理しない。IME の変換中の Esc・`Process` は何もしない。
- AC3: pass — `end`: 満杯欄は最後の桁、空の欄は先頭、最後の桁だけ空白なら入力の次。
- AC4: pass — 古い組は入れ替わる・片方でも変えていれば直さない・Esc を別用途にしていれば奪わない・版 4 の保存値は直さない。
- AC5: pass — mutation 9 通り（SBCS Insert・SBCS End・DBCS End・DBCS Insert の委譲、IME のガード、組の判定 every→some、訂正の無効化、版 1 の向き、`end` の最後の桁）すべて検出。
  DBCS の 2 通りは最初は素通りし、DBCS 欄のテストを足して検出した。

## 失敗の証跡

```
$ npx vitest run <キー操作のテスト>   # 版 4 に End: local:erase-eof を入れた直後（D1 で破棄した案）
 Tests 8 failed | 508 passed (516)
 FAIL test/pane-nav.test.ts > Home/End で最初/最後の入力欄へ（欄外＝ペインにフォーカス時）
 FAIL test/screen-grid-cursor-no-edit.test.ts > 実際に文字を入力すると edit を emit する（expected 'ABCDEX' got 'XBCDE'）
 FAIL test/screen-grid.test.ts（End で caret を置く DBCS・折り返しの 6 件）
```
End を Erase EOF にしたことで、End を「欄の末尾へ」として使うテストが落ちた。原典で End は欄の末尾へ移る操作だと確かめ、割り当てを外した（D1）。

```
$ python3 mut-keys.py   # DBCS 欄のテストを足す前
SURVIVED DBCS End 委譲 :: 34 passed (34)
SURVIVED DBCS Insert 委譲 :: 34 passed (34)
```

## 起動確認（smoke）

```
$ aidev smoke
smoke: 20260921-acs-default-keys
$ node launcher/smoke.mjs
{"level":40,"time":1789986152218,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789986152240,"host":"127.0.0.1","port":44817,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 44817)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 実ブラウザ・実キーボード（jsdom の KeyboardEvent で確かめた）。Ctrl+Pause がどちらの `key` で届くか（D4）、Shift+Insert の貼り付けがブラウザで止まるか。
- ACS の GUI で選択中に Esc を押したときに選択が残るか（D3）。
