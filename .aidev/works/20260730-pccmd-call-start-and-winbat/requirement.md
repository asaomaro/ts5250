# 要件: Windows 実機で見つかった 2 件を直す（`CALL START` と `start.bat` の master key）

## 背景 / 課題

**Windows 実機で動かした利用者から、2 件の不具合と原因・修正内容が届いた**
（push できない環境で修正したため、内容だけを持ち込む。原資料は `不具合修正.pdf`＝
`fix_STRPCCMD` / 2026-07-30 17:55）。

いずれも **backlog の未検証項目「Windows での実行経路（`spawn(..., { shell: true })` →
`cmd.exe /c`）——Linux でしか確認していない」を実機で踏んだ結果**である。

### 1. `start.bat` に `--auto-secret-key` が無い

Windows で `start.bat` を使うと、新規システム追加時に自動サインオンのパスワードを
保存しようとして `secret key not configured; cannot store password` になる。

`start.sh`（Linux/macOS 版）は起動時に常に `--auto-secret-key` を付けており、
`AS400_SECRET_KEY` が無ければ自動生成して `.env` に保存する。
**`start.bat` にはこのフラグが無く、master key が一切設定されないままだった**
——同じ「単一利用者向けのローカル起動」なのに Windows だけ機能が欠けている。

### 2. `CALL START` 形式のアプリが起動直後に消える

`STRPCCMD` 経由で
`CMD /C "NET USE \\SERVER & CALL START "title" /B "app.exe" args…"`
のような **`CALL START` を含むコマンド**を実行すると、`app.exe` が Windows 実機で
**起動直後に強制終了される**。サーバーのログには `outcome: {status: "started"}` としか出ず、
エラーは一切見えない（＝利用者には「何も起きない」ように見える）。

- `CALL` を含まない `START "title" /B "app.exe"` や、実行ファイルの直接指定は問題なく動く
- **手動でコマンドプロンプトから同じ文字列を実行すると成功する**
  ——コマンド内容・環境・権限の問題ではなく、この Web エミュレーターの
  Node.js プロセスが実行したときだけ再現する

原因（Windows のジョブオブジェクト絡みで、`spawn()` の子プロセスが `CALL` 経由の
入れ子で起動されると巻き添えで終了させられる、と見られる）は特定しきれていないが、
**`START` の直前の `CALL` を取り除けば実機で毎回問題なく動く**ことは確認済み。

## 目的 / ゴール

- Windows でも `start.bat` から起動すればパスワード保存が使える（`start.sh` と同じ）
- `CALL START` 形式のコマンドで起動したアプリが**消えない**
- **調べ直しの手戻りを防ぐ**——効かなかった手・原因でなかったものを記録として残す

## スコープ

### 対象

- `start.bat` に `--auto-secret-key` を足す（`start.sh` と同じ理由づけのコメント付き）
- `packages/server/src/pc-command.ts`: 実行前に `START` の直前の `CALL` を落とす
- 同ファイル: `spawn` に `detached: true` を足す（単体の再現では効果が確認できている）
- 回帰テスト（`packages/server/test/pc-command.test.ts`）
- backlog の「Windows での実行経路」に**実機で分かったこと**を書く

### 対象外

- `CALL START` が消える**根本原因の特定**（実機の Windows でしか追えず、
  回避策で実害が消えているため。分かっていることは記録に残す）
- 実行結果をホストへ返す道・PCO 終了標識など、backlog の他の項目
- Windows 実機での再検証（この環境に Windows が無い。**原資料の実測を根拠とする**）

## 機能要件

- `CALL START` / `call start`（大文字小文字を問わない）を `START` に落として実行する
- `&` で繋いだ形（`CMD /C "NET USE … & call start …"`）でも効く
- **`CALL` の無い `START` は変えない**／`CALL START` を含まないコマンドは変えない
- 置換は**実行のためだけ**——`allow` の照合や記録は利用者が書いた文字列で行う
  （許可判定を書き換えた文字列で行うと、利用者が許可した文面と実際の判定がずれる）
- `start.bat` の変更は `start.sh` と**同じ意味**（単一利用者向けの自動生成）

## 非機能要件 / 制約

- **この環境に Windows が無い**。実機の裏付けは原資料（PDF）に依存する。
  そのことを記録・PR に明示し、実機でしか確かめられない部分を「未検証の穴」として残す
- 既存の挙動（Linux の実行経路・`allow` 判定・タイムアウト）を変えない
- 秘密を成果物に書かない

## 完了条件 (受け入れ基準)

- [ ] `start.bat` が `--auto-secret-key` を付けて起動する（`start.sh` と同じ位置・同じ趣旨）
- [ ] `CALL START` を含むコマンドが `START` に落ちて実行される
- [ ] 大文字小文字・`&` で繋いだ実例で効く
- [ ] `CALL` の無い `START`・無関係なコマンドは変わらない
- [ ] `allow` 判定と記録は**元の文字列**のまま
- [ ] 回帰テストが通る（既存テストも壊れない）
- [ ] 効かなかった手・原因でなかったものがコード上のコメントか記録に残っている
- [ ] backlog の「Windows での実行経路」に結論を書いた

## 未確定事項 / 確認したいこと

- 置換は 1 回だけでよいか（`&` で 2 つ以上の `CALL START` が並ぶ場合）→ spec で決める
- `detached: true` を入れる／入れないの判断（原資料は「両方残す方が安全側」）→ research で確かめる
