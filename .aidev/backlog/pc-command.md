# PC コマンド（STRPCO / STRPCCMD）

2026-07-28 に `STRPCCMD` の検出・実行・信頼境界まで実装した
（`.aidev/works/20260728-strpco-strpccmd`）。実機で 4 ケース検証済み。
その後に残った項目をここへ積む。

2026-07-30 に **Windows 実機での実行経路が確認され**、`CALL START` 形式のアプリが
起動直後に消える不具合が見つかって直った（`20260730-pccmd-call-start-and-winbat`）。
併せて `start.bat` に `--auto-secret-key` が無く、Windows だけ
パスワード保存が使えなかった件も直した。

2026-08-23 に**別の Windows 11 実機で測り直した**ところ、`CALL START` でアプリが消える現象は
**再現しなかった**（40 ケース。`20260823-pccmd-windows-verify`）。回避策は残している
（詳細は下の「未検証」節）。

## 未検証（実装は入っているが確かめられていない）

- [ ] **PCO 終了標識** `27 00 FC D7 C3 D6 40 83 80 82 00` の実物確認
  - 実機に `ENDPCO` コマンドが無く誘発できなかった（research D6）。値は xtn5250 の定数から採った
  - 現状は「一致したら実行せず実行キーだけ返す」保守的な扱い。**誤検出しても害が無い**形にしてある
  - PC Organizer を持つ環境（Windows の PCOMM / ACS）を ACS タップで捕まえれば採れるはず
- [x] **Windows での実行経路**（`spawn(..., { shell: true })` → `cmd.exe /c`）
  - Linux でしか確認していない。Electron 版を Windows で動かして `start` / `notepad` を試す
  - **2026-07-30 に Windows 実機で確認され、不具合 1 件が見つかって直った**
    （`20260730-pccmd-call-start-and-winbat`。実測は push できない別環境で行われ、
    こちらへは記録として持ち込まれた）:
    - **`CALL START "title" /B "app.exe"` は起動したアプリが直後に消える。**
      ログには `outcome: {status: "started"}` としか出ず、エラーは見えない
    - `CALL` を含まない `START …` と実行ファイルの直接指定は問題なく動く。
      **手でコマンドプロンプトから同じ文字列を実行すると成功する**
      ——この Node.js プロセスが実行したときだけ再現する
    - 根本原因は**未特定**（Windows のジョブオブジェクト絡みと見られる）。
      `START` の直前の `CALL` を落とす回避策を入れた（`stripCallBeforeStart`）。
      **効かなかった手**（`detached` 単独・`cmd.exe` 直接呼び出し・CCSID・EDR）は
      `pc-command.ts` の docstring に表で残してある
- [x] **別の Windows 実機で測り直した（`CALL START` は消えるか）** — 2026-08-23 完了
      （`20260823-pccmd-windows-verify`。**再現しない**）
  - Windows 11 Pro build 26200.9168（`cmd.exe` 10.0.26100.8875）・Node 24.18.0・
    Electron 32.3.3・Defender ＋ ESET の実機で **40 ケース**
    （コマンドの形 8 × spawn 指定 4 × アプリ種別 2 × 親プロセス 3 ＋ argv 突合 8）。
    **アプリが消えたケースは 0**
  - `CALL` の有無で**起動された側の `argv` は完全に同一**（パスに空白を含む形でも
    引用符は剥がれない）。親プロセス（bash 起動の node / cmd.exe 起動の node /
    **Electron の main プロセス**＝配布形と同じ経路）は**どれもジョブオブジェクトに
    入っていない**（`IsProcessInJob` で実測）——当時の「ジョブオブジェクト絡み」という
    見立ての前提がこの機械には無い
  - 生の測定値は `.aidev/works/20260823-pccmd-windows-verify/research.md`、
    要約は `packages/server/src/pc-command.ts` の `stripCallBeforeStart` docstring
- [ ] **`CALL START` が消える根本原因の特定（原資料の 1 台でしか再現していない）**
  - 回避策（`CALL` を落とす）で実害は消えており、**別の Windows 11 実機では再現しない**
    （上の項目）。残るのは「あの 1 台で何が効いていたか」で、
    **あの環境に届かない限り測れない**
  - ~~同じ性質の入れ子（`CALL` 以外の経路）で同じことが起きるかも未確認~~
    → `CMD /C "…"` の入れ子・`&` 連結・`CALL` の直付けは測った（いずれも生存）
  - 再訪するとき最初に測るもの: `ComSpec` の指す先 / `cmd.exe` の版 /
    `HKCU|HKLM\Software\Microsoft\Command Processor` の `AutoRun` /
    親プロセスがジョブに入っているか / `app.exe` の置き場（`NET USE` した UNC 共有か）
- [x] **Windows 実機での回帰確認の自動化** — 2026-08-23 完了
  - `packages/server/test/pc-command-windows.test.ts`（`describe.skipIf(!isWin)`）。
    **本番の `runPcCommand` 経路**で「アプリ」を起動し、**シェルが終わったあとも
    書き足し続けるか**で生存を測る（`CALL START …` / `CMD /C "NET USE & CALL START …"` /
    対照の `START …` の 3 形）。空振り検証: アプリを 1 拍で終わらせるミュータントで
    3 件とも死亡
  - 併せて `pc-command.test.ts` の POSIX 前提を外した——`test -d .` は Windows で落ち、
    `sleep 5` は Git 同梱の `sleep.exe` が PATH に居るかで結果が変わっていた。
    **Windows 実機で 39 件（3 ファイル）が通る**
  - Electron 版の Windows ビルドで回す道は**採らなかった**。生存に効くのは `spawn` の
    経路だけで、Electron の main プロセスを親にした測定でも結果は同じだった
    （上の項目の「親プロセス」の行）。テストなら `npm test` で毎回回る
- [ ] **DBCS を含むコマンド**（SO/SI 入り）。標識の読み取りは SBCS 前提で書いている
- [ ] V7R2 以降の `PCCMD` 1023 文字上限
  - 実機は 200 文字を受け付けず、対話ジョブが応答待ちメッセージで止まった（research D4）

## 機能として検討の余地があるもの

- [ ] **常駐セッションでの扱い**（`hostserver.md` の「サービス型セッションの常駐化」と関係）
  - ブラウザを閉じている間に届いた PC コマンドは、実行はされるが通知が届かない
  - 現状は `entry.pcCommands`（20 件）に残るだけで、`WsOpened` では配らない
- [ ] **実行結果をホストへ返す道**
  - 5250 側にその経路が無いことは実測済み（ホストは実行の有無を問い合わせない）。
    どうしても要るならデータ域・IFS 経由で「こちらから書きに行く」しかない
- [ ] **許可パターンの書きやすさ**
  - いまは正規表現の全体一致 1 本。運用してみて厳しければ「プログラム名だけの照合」を足すか検討する
    （前方一致は後置きが素通りするので採らない）
