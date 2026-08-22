# Windows 実機でテストを回す（POSIX 前提の残り）

2026-08-23 に **Windows 11 実機で `packages/server` の suite を初めて通した**
（`20260823-pccmd-windows-verify`。目的は PC コマンドの回帰確認を Windows で自動化すること）。
その副産物として「Windows では落ちるが Windows の不具合ではない」テストが見えたので、
**前提の整え方**と**残っている落ち方**をここに置く。

## 回すのに要ること（この順で潰した）

| 手 | やらないとどうなるか |
|---|---|
| `npm install` | workspace が `node_modules` に張られておらず、**27 ファイルが collect 段階で落ちる**（`Cannot find package '@ts5250/vt'`） |
| `npx tsc -b` | `packages/vt/dist` が無い＝**同じ 27 ファイルが落ちる**（張ってあっても未ビルドだと解決できない） |

整えた後の baseline: **1,243 件中 12 件 failed**（うち 1 件は `pc-command.test.ts` の
`test -d .` で、この作業で直した。残り 11 件が下）。

## 残り 11 件（外部コマンド依存・POSIX 前提・チェックアウト差）

- [ ] `output-dir.test.ts`「書き込めないディレクトリは「書き込めません」」
  - `chmod 0o000` が Windows では効かない（ACL なので書けてしまう）。`isRoot` と同じ要領で
    プラットフォーム判定を足すか、ACL で落とす
- [ ] `print-dest.test.ts` 2 件（「宛先が引ければ警告なし」「応答が遅い宛先は打ち切って警告する」）
  - `lpstat` が無いので常に「プリンターが見つかりません」に倒れる
- [ ] `printer-output.test.ts`「autoPrint は lp 不在なら warn して printed=false」
  - Windows は `lp` ではない経路（`printer-output.ts` の win32 分岐）を通るので前提が違う
- [ ] `printer-output-windows.test.ts`「**Windows 以外は**従来どおり lp へ」
  - **Windows で走ると前提が反転する**テスト（`skipIf` が無い）。名前のとおり非 Windows 専用
- [ ] `zip-writer.test.ts` 5 件
  - `unzip` が無い（`HAS_UNZIP` が効いて skip される分は問題なし）
  - **`python3` の検出が Windows で当たらない**——Microsoft Store のアプリ実行エイリアスが
    「在る」ように見えて、実行すると「Python was not found」と言って失敗する。
    `HAS_PYTHON3` は**実際に走らせて版数が返るか**で判定する必要がある
- [ ] `prebuilt-fresh.test.ts`「**ソースを変えたら作り直されている**」
  - **DLL は古くない。** `core.autocrlf=true` の Windows チェックアウトで `.rs` /
    `Cargo.toml` / `Cargo.lock` が CRLF になり、`manifest.json` の sha256（Linux の LF で
    取った指紋）と食い違う。リポジトリに **`.gitattributes` が無い**のが原因
  - 直し方は 2 択。**前者を推す**:
    1. `.gitattributes` に `* text=auto eol=lf` を置き、**作業ツリーを Linux と同一バイトにする**
       （`start.bat` を LF のまま保っている既存の方針と揃う。バイト指紋の検査は
       「同一バイトのチェックアウト」を前提にしている）
    2. 指紋の計算で改行を正規化する（`prebuilt-manifest.py` と
       `prebuilt-fresh.test.ts` の**両方**を同時に変えないと検査が意味を失う）

## なぜ片づける価値があるか

**Windows は「配布形（Electron 版）が実際に動く唯一の OS 固有経路」を持つ**
（`spawn(shell: true)` → `cmd.exe`・印刷・PDF フォント探索）。ここが赤いままだと、
Windows で回した人が「元から落ちている」と流すようになり、
**本当の回帰が混ざっても気づけない**。上の 11 件はいずれも
「テスト側の前提」であって製品の不具合ではないので、判定を足すだけで緑にできる。
