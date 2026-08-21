# 調査: VT 端末エミュレータ

requirement の「未確定事項」を**実測**で潰した記録。推測は残さない。

## 1. IBM i は VT を受けるか — **受ける。ただしホスト構成次第で画面が来ない**

### 1.1 交渉（2 台で実測）

素の telnet クライアントを書いて、IBM i の 23 番に VT として当てた。

```
< DO NEW-ENVIRON        ← **5250 と同じ**。IBM i の見分け（`telnet.ts` の sawNewEnviron）
< DO TTYPE              → WILL TTYPE
< SB TTYPE SEND         → SB TTYPE IS VT220
< WILL ECHO             → DO ECHO      ← **文字モードが成立する**
< WILL SGA              → DO SGA
```

**端末タイプの選び方が挙動を分ける。**

| 申告 | ホストの反応 |
|---|---|
| `VT220` / `VT100` | **SEND は 1 回だけ**。名前をその場で受け取る |
| `xterm-256color` / `ansi` | **SEND を 2 回**送ってくる（＝知らない名前なので次の候補を促している）。同じ名前を返すと打ち切る |

→ IBM i には **`VT220` を申告する**。xterm 系の名前は通るが、ホストは VT100 相当としてしか扱わない。

### 1.2 pub400 では画面が来る。SR-OSAKA では来ない

**pub400（QAUTOVRT=32767）**: サインオン画面が**そのまま ANSI で**降ってくる。
IBM i が 5250 のパネルを VT のエスケープ列に翻訳している。

```
ESC[?3l ESC[?7h ESC[5;25H ESC[1;1H ESC[2J ESC[0m … ESC[1m … ESC[4m … ESC[7m
Display name. . . :   QPADEV001C
```

使っている語彙は**狭い**——`DECCOLM(?3)` / `DECAWM(?7)` / `CUP` / `ED` / `EL` / `SGR 0,1,4,7` だけ。
**IBM i 側は VT100 相当で足りる。**

**SR-OSAKA**: 交渉は同じところまで進むが、**画面を 1 バイトも送らない**（生 43 B ＝ 交渉のみ）。
`VT100` を申告した場合は接続ごと閉じる。

原因はホスト側にあり、**QSYSOPR のメッセージで確定した**（VT で繋いだ時刻と一致）:

```
CPF1194  08:26:49  サブシステム QBASE がワークステーション QPADEV000C をオフに構成変更した
```

仮想装置は**作られている**。作られた装置でジョブが起きず、サブシステムがオフにしている。

**この過程で backlog の宿題も 1 つ片付いた**——`tn3270-ibmi.md` に「SR-OSAKA が装置名を拒む理由が
未確認（QAUTOVRT が読めなかった）」と残っていたが、`QSYS2.SYSTEM_VALUE_INFO` を製品の SQL 経路で
読めた。**QAUTOVRT=200**（自動作成は有効）で、仮説だった「0 だから」は**誤り**。

| 値 | SR-OSAKA | pub400 |
|---|---|---|
| QAUTOVRT | **200** | 32767 |
| QMAXSIGN | **3** | 5 |
| QCCSID | 65535 | 273 |
| QPWDLVL | 0 | 3 |
| QAUTOCFG | 1 | 1 |

⚠ **SR-OSAKA の QMAXSIGN は 3**。実機検証でサインオンを失敗させる試行は 3 回までに抑える。

### 1.3 CPF1120 は VT でも出る。**原因も対処も 5250/3270 と同じ**

pub400 に VT で繋いで正しい資格情報を打ったのに `CPF1120 - User ... does not exist or password
not correct` で弾かれた。**NEW-ENVIRON を断っていた**のが原因。

pub400 は `QCCSID=273`（ドイツ語）。無申告だとホストは装置を 273 で作り、こちらが送った ASCII の
`@`（0x40）を別の字として読む。**パスワードに記号が入っていると必ず落ちる。**

RFC 2877 の 3 つを NEW-ENVIRON で申告したら**そのまま IBM i のメインメニューまで到達した**。

```
SB NEW-ENVIRON IS  KBDTYPE=USB  CODEPAGE=37  CHARSET=697
→  MAIN                           IBM i Main Menu
                                                 System:   PUB400
```

→ **`packages/tn3270/src/telnet/device-env.ts` と同じ表が VT でも要る。**
（3 つ目の複製になる。spec で「括るか複製するか」を決める）

### 1.4 IBM i の VT で使える入力

- **Tab** = 次の欄へ（サインオン画面でユーザー名欄 → パスワード欄に移った）
- **CR** = Enter（5250 の Enter AID 相当）
- 打鍵は**ホストがエコーする**（パスワード欄は非表示のままエコーが来ない）
- **打鍵を一度に流し込むと落ちる**。1 文字ずつ ~50ms 空け、欄の移動後は ~700ms 待つ必要があった
  （一括送信では欄の移動が間に合わずパスワードが入らなかった）

## 2. Linux 側 — 検証環境を docker で立てた

`debian:stable-slim` ＋ `busybox telnetd` ＋ `vim-tiny` / `less` / `tmux` / `iconv`。
`LANG=en_US.UTF-8`、`TERM=xterm-256color`。ポートは **2331**（2323 は別プロジェクトが使用中だった）。

```
< DO ECHO   → WONT   （エコーはホスト側。こちらは持たない）
< DO NAWS   → WILL ＋ SB NAWS 80x24
< WILL ECHO → DO
< WILL SGA  → DO
```

`stty size` が **24 80** を返した＝**NAWS が効いている**。`locale charmap` は UTF-8。

### 2.1 実アプリが実際に使う語彙（生バイトから採取）

**`vi`（vim.tiny）に入るとき:**

```
ESC[?1049h  ESC[22;0;0t  ESC[>4;2m  ESC[?1h  ESC=  ESC[?2004h  ESC[1;24r
ESC[?12h  ESC[?12l  ESC[22;2t  ESC[22;1t  ESC[27m ESC[23m ESC[29m ESC[m
ESC[H  ESC[2J  ESC[?25l  …  ESC[94m
```

**出るとき:** `ESC[?1049l  ESC[>4;m  ESC[23;2t  ESC[23;1t  ESC[?1l  ESC>  ESC[?25h`

**`less`:** `ESC[?1049h  ESC[22;0;0t  ESC[24;1H  ESC[?1h  ESC=`（**DECSTBM は使わない**。
最下行に置いて改行でスクロールさせる方式）

**bash:** プロンプトのたびに `ESC[?2004h` / `ESC[?2004l`（bracketed paste）を出す。

**ホストが応答を要求してくる:** `ESC[c`（DA1）が飛んできた。**返さないと待たせる。**

→ 実装に要るものが確定した:
`1049`（**`47` / `1047` は使われていない**）・`DECSTBM`・`DECCKM(?1)`・`DECKPAM(ESC=)`・
`2004`・`?25`・`?12`・`SGR 22/23/27/29` の個別解除・**明色 90-97 / 100-107**・
`XTWINOPS(t)` と `modifyOtherKeys(>4;Nm)` は**壊れずに読み飛ばせれば足りる**・**DA1 応答**。

### 2.2 日本語

UTF-8 の「あいう」がそのまま往復した（`e3 81 82 e3 81 84 e3 81 86`）。
`iconv` があるので Shift_JIS / EUC-JP の試験データを作れる（`あいう` → `82 a0 82 a2 82 a4`）。

## 3. 符号化 — 復号は標準、**符号化は自前が要る**

Node（フル ICU）で実測:

| | `TextDecoder` | `TextEncoder` |
|---|---|---|
| utf-8 | OK | OK |
| shift_jis / windows-31j | **OK** | **不可**（UTF-8 専用） |
| euc-jp | **OK** | **不可** |
| iso-2022-jp | **OK** | **不可** |

→ **受信側は表を持たなくてよい。送信側だけ要る。**
`TextDecoder` を全 2 バイト列に当てて**逆引き表を実行時に組み立てられる**（データファイル不要）。
`@ts5250/ebcdic` の 18,900 行を抱える轍を踏まずに済む。spec で採否を決める。

## 4. 突合の物差し（oracle）

`tmux` がコンテナに入っており、`tmux capture-pane -p`（素）/ `-e`（属性つき）で
**画面を機械的に取り出せる**ことを確認した。3270 で `s3270` を oracle にしたのと同じ役回りができる。

## 5. まだ確かめていないこと（spec / test へ送る）

- **リサイズ時の行の再折返し**。今回は測っていない。「折り返さない」で始めてよいかは spec で決める。
- **マウス報告の実往復**。申告（`?1000h` / `?1006h`）が通ることは見たが、
  実アプリ（`vim` のマウス操作）での往復は未確認。
- **IBM i の VT でファンクションキーが何に写るか**。3270 では IBM i 自身が
  マッピング画面を持っていた（PF2）。VT にも同種の案内があるか未確認。
- **`less` が DECSTBM を使わない**のは版によるかもしれない。他の実装（`more` / `man`）は未採取。
