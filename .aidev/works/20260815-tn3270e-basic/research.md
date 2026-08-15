# 調査: 基本 TN3270E（RFC 2355）

requirement の未確定 3 点を、**RFC 2355 の直読**と**実測**で潰す。

## 調査の問い

- Q1: TN3270E を提示するホストが手元にあるか。無ければどう検証するか。
- Q2: `FUNCTIONS` を空集合で合意する手順は仕様上どうなるか。
- Q3: `DEVICE-TYPE` に送る型名は基本 TN3270 と同じでよいか。
- Q4: 基本 TN3270 で使っていた `端末タイプ@装置名` の慣行は TN3270E でどう扱うか。
- Q5: 5 バイトヘッダのどのフィールドを実装する必要があるか。

---

## 判明した事実

### F1: 手元の 3 ホストはどれも TN3270E を提示しない 〔Q1〕

s3270（RFC 2355 実装）を各ホストへ繋ぎ、telnet オプション 40（0x28）の交渉を観測した。

| ホスト | 結果 |
|---|---|
| TK4-（MVS 3.8j / Hercules） | 提示なし。`connected-3270`（基本） |
| pub400（IBM i 7.5） | 提示なし |
| 社内 IBM i 7.3 | 提示なし。`connected-3270`（基本） |

IBM i の 3270 対応は基本 TN3270 止まり。5250 の互換層なので筋は通る。

### F2: 検証経路は自作できる。**s3270 を独立オラクルにする** 〔Q1〕★

**RFC 2355 に従う最小の TN3270E サーバを書き、s3270 を繋いで成立を確認した。**

```
DO TN3270E                    → WILL TN3270E
SB TN3270E SEND DEVICE-TYPE   → DEVICE-TYPE REQUEST IBM-3278-2-E
DEVICE-TYPE IS IBM-3278-2-E CONNECT TSTTERM
                              → FUNCTIONS REQUEST [BIND-IMAGE, RESPONSES, SYSREQ]
FUNCTIONS IS [RESPONSES, SYSREQ]
0000000000 f5c3 1140 40 1d60 …（5 バイトヘッダ＋3270 データ）
```

s3270 は `connected-tn3270e` に到達し、画面に `TN3270E TEST` を表示した。
s3270 のトレースでも `RCVD TN3270E(3270-DATA NO-RESPONSE 0)` →
`EraseWrite … StartField(protected) 'TN3270E TEST'` と復号されている。

→ **z/OS 無しで TN3270E を実装・検証できる。** 基本 TN3270 と同じ方法論
（自作サーバに同じバイトを流し、s3270 を独立した正解として突き合わせる）がそのまま使える。

### F3: 機能を減らすときは `IS` ではなく `REQUEST`（対案）を返す 〔Q2〕★

RFC 2355 §7.2.1 の直読:

> Upon receipt of a FUNCTIONS REQUEST command, the recipient has two choices:
> - it may respond in the positive … To do this, it sends the FUNCTIONS IS command
>   **with the function-list exactly as it was received.**
> - it may respond in the negative by sending **a FUNCTIONS REQUEST command** in which
>   the function-list differs from the one it received …

> **Note that it is possible that the function-list agreed to is null;
> this is referred to as "basic TN3270E".**

- **`FUNCTIONS IS` は「受け取ったリストをそのまま」返す場合にしか使えない。**
- 減らしたいときは **`FUNCTIONS REQUEST`** で対案を出し、相手が `IS` で受けるまで往復する。
- ループ防止規則: **一度相手が外した機能を、こちらから足し直してはならない。**
- 空リストでの合意＝**basic TN3270E**。今回のスコープはこれ。

> **［訂正］F2 のプロトタイプは仕様違反だった。** 部分集合を `FUNCTIONS IS` で返しており、
> 上の規則に反する。**s3270 が寛容に受理しただけ**で、正しくは `FUNCTIONS REQUEST` を返す。
> 実装とハーネスの両方をこの規則に合わせること。
> 「動いた」は「正しい」ではない、の再確認（前 work の decisions D13 と同じ形）。

### F4: TN3270E の型名は **`IBM-3278-*`**。`IBM-3279-*` は使わない 〔Q3〕★

RFC 2355 §7.1 の直読:

> Valid device-types are:
>   terminals: `IBM-3278-2` `IBM-3278-2-E` (24 row x 80 col display)
>              `IBM-3278-3` `IBM-3278-3-E` (32 row x 80 col)
>              `IBM-3278-4` `IBM-3278-4-E` (43 row x 80 col)
>              `IBM-3278-5` `IBM-3278-5-E` (27 row x 132 col)
>              `IBM-DYNAMIC` (no pre-defined display size)
>   printers:  `IBM-3287-1`

> the use of '3278' … is NOT intended to exclude any particular device capabilities …
> negotiation of device-type `IBM-3278-2-E` does **NOT** in and of itself preclude the use of
> any of the functions associated with a physical 3279 … A client's ability to support the more
> advanced functions … will be indicated **by the combination of Read Partition Query and
> Query Reply**.

**実測が RFC を裏付けている**——同じ s3270 が、
- 基本 TN3270（Hercules / IBM i）では `TERMINAL-TYPE IS **IBM-3279-2-E**`
- TN3270E（F2 の自作サーバ）では `DEVICE-TYPE REQUEST **IBM-3278-2-E**`

と**モードで型名を変えている**。つまり型名は基本 TN3270 と別に組み立てる必要がある。

また §7.1 は画面サイズについてもこう書く:

> All of the terminal device-types support a "primary" display size of 24 rows by 80 columns.
> The "-3", "-4" and "-5" types each support an "alternate" display size …

これは前 work の decisions **D5**（標準 24x80 ＋ モデル固有の代替サイズ）を
**RFC 1576 とは別の出典で再確認**したことになる。

`-E` 接尾辞は「拡張データストリームの一部を支える意思がある」クライアントだけが名乗る。
本実装は拡張色・ハイライトを実装済みなので `-E` を名乗ってよい。

### F5: LU 名は `CONNECT` で渡す。`@装置名` の慣行は使わない 〔Q4〕

基本 TN3270 には LU 指定の仕組みが無いため、端末タイプ文字列に `@<装置>` を付ける慣行で
代用していた（前 work で実測。Hercules / IBM i とも受理）。

TN3270E では **`DEVICE-TYPE REQUEST <型名> CONNECT <device-name>`** が正式な手段。
**二重指定を避けるため、TN3270E 経路では `@` 記法を使わない。**
`deviceName` オプションは、経路に応じて自動的に振り分ける。

サーバは `DEVICE-TYPE IS <型名> CONNECT <名前>` で受理するか、
`DEVICE-TYPE REJECT REASON <code>` で拒否する。理由コード（§3 / §7.1.5）:

| コード | 名前 | 意味 |
|---|---|---|
| 00 | CONN-PARTNER | 相手方の接続に関する問題 |
| 01 | DEVICE-IN-USE | 要求した device-name が使用中 |
| 02 | INV-ASSOCIATE | ASSOCIATE が不正 |
| 03 | INV-NAME | 名前がサーバに未知 |
| 04 | INV-DEVICE-TYPE | 型名を支えていない |
| 05 | TYPE-NAME-ERROR | 名前と型の不整合（端末/プリンタ違い等） |
| 06 | UNKNOWN-ERROR | その他 |
| 07 | UNSUPPORTED-REQ | 要求の種類に応えられない |

### F6: 基本 TN3270E が要求するヘッダは 2 値だけ 〔Q5〕★

RFC 2355 §9 の直読:

> Basic TN3270E requires the support of only the following TN3270E header values:
>   DATA-TYPE `3270-DATA`
>   DATA-TYPE `NVT-DATA`
> **The REQUEST-FLAG, RESPONSE-FLAG and SEQ-NUMBER fields are not used in basic TN3270E.**

> since neither the SCS-CTL-CODES function nor the DATA-STREAM-CTL function is agreed to,
> **basic TN3270E refers to terminal sessions only.**

- 実装が要るのは **`3270-DATA`(0x00) と `NVT-DATA`(0x05)** の識別だけ。
- 3 つのフラグ/番号フィールドは**送信時 0、受信時は無視**でよい。
- §9.1: 接続は **最初 3270 モード**。`NVT-DATA` の送信はモード切替の要求を意味する。
  → 今回は NVT モードを実装しないが、**`NVT-DATA` を受け取っても壊れない**ことは要る。

### F7: コマンド・機能・DATA-TYPE のコード（§3 / §7.2.2 / §8.1.1）

```
コマンド      ASSOCIATE 00 / CONNECT 01 / DEVICE-TYPE 02 / FUNCTIONS 03
              IS 04 / REASON 05 / REJECT 06 / REQUEST 07 / SEND 08
機能          BIND-IMAGE 00 / DATA-STREAM-CTL 01 / RESPONSES 02
              SCS-CTL-CODES 03 / SYSREQ 04
DATA-TYPE     3270-DATA 00 / SCS-DATA 01 / RESPONSE 02 / BIND-IMAGE 03
              UNBIND 04 / NVT-DATA 05 / REQUEST 06 / SSCP-LU-DATA 07 / PRINT-EOJ 08
telnet option TN3270E = 40 (0x28)
```

---

## 影響範囲

- `telnet/constants.ts` — TN3270E のオプション番号とコマンド／機能／理由コードを追加
- `telnet/telnet.ts` — `DO TN3270E` の受理と、TN3270E サブネゴシエーションの状態機械
- 新規 `telnet/tn3270e.ts` — DEVICE-TYPE / FUNCTIONS の交渉と 5 バイトヘッダの付与・解釈
- `telnet/terminal-type.ts` — **TN3270E 用の型名**（`IBM-3278-*`）を組み立てる関数を追加
- `session/session.ts` — 経路の選択（TN3270E か基本か）と `deviceName` の振り分け
- `test/harness/mini3270.ts` — TN3270E サーバとして振る舞えるよう拡張（F3 の規則に従う）

**基本 TN3270 の経路は残す。** ホストが TN3270E を提示しなければ従来どおり動くこと。

## 実現性 / リスク

**実現性は高い。** 最大の不確実性だった「検証できる相手がいない」は F2 で解消した。

| リスク | 対応 |
|---|---|
| ［中］`FUNCTIONS` 交渉が往復しうる（F3） | ループ防止規則を実装し、往復回数に上限を設けて打ち切る |
| ［中］自作ハーネスが仕様違反だと誤検証になる（F3 の実例） | ハーネスも RFC どおりに直し、**s3270 が受理すること**を先に確かめてから自実装を当てる |
| ［小］`NVT-DATA` を受けたときの挙動 | 記録して読み飛ばす。壊れないことをテストで固定 |
| ［小］型名の取り違え（F4） | 基本用と TN3270E 用の組み立てを**別関数**にして型で分ける |

## spec への申し送り

1. **`FUNCTIONS` は空集合を要求する**（basic TN3270E）。減らす側は `REQUEST` で対案（F3）。
2. **型名は `IBM-3278-<model>[-E]`**。基本 TN3270 の `IBM-3279-*` とは別に組み立てる（F4）。
3. **LU 名は `CONNECT`**。TN3270E 経路では `@装置名` を使わない（F5）。
4. **ヘッダは 2 値だけ**扱う。フラグ 3 つは送信 0・受信無視（F6）。
5. **ハーネスを先に RFC 準拠へ直す**——プロトタイプは `IS` で部分集合を返す違反があった（F3）。
6. 退行防止: **TN3270E を提示しないホストで従来どおり**動くことを、既存の E2E で担保する。
