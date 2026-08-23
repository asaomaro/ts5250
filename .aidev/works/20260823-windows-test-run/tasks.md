# タスク

- [x] `output-dir.test.ts`: `chmod` が効かない環境の判定を `cannotDenyWrite` に広げる
- [x] `print-dest.test.ts`: suite ごと `skipIf(win32)`（偽コマンドが `#!/bin/sh`）
- [x] `printer-output.test.ts`: `lp` 不在の degrade を `skipIf(win32)`
- [x] `printer-output-windows.test.ts`: 非 Windows 用の対照を `skipIf(win32)`
- [x] `zip-writer.test.ts`: `python3` を**実際に走らせて**判定する（Store のエイリアス対策）
- [x] `.gitattributes` を新設（`* text=auto eol=lf` ＋ `*.ucm -text` ＋ バイナリの明示）
- [x] 作業ツリーを再正規化し、`prebuilt-fresh` が通ることを確かめる
- [x] `packages/ebcdic` の到達可能性ガード 2 件のパス正規化（**fail-open を塞ぐ**）
- [x] `packages/tn5250` の `tls.test.ts`: `mktemp` → `mkdtempSync`、`openssl` で skip
- [x] 全 workspace のテスト・lint・build を Windows で緑にする
- [x] backlog を閉じ、新たに見つかった 2 件も記録する
