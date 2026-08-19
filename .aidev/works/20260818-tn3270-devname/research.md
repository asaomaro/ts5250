# 調査

## A. 交渉の順（実測）

```
RX  ff fd 27 ff fd 18            ← **DO NEW-ENVIRON(0x27)** / DO TERMINAL-TYPE(0x18)
TX  ff fb 27  /  ff fb 18        ← WILL 両方
RX  ff fa 27 01 03 IBMRSEED…     ← SB NEW-ENVIRON SEND
    （同じ塊で SB TERMINAL-TYPE SEND も来る）
TX  ff fa 27 00 … KBDTYPE/CODEPAGE/CHARSET … ff f0
TX  ff fa 18 00 IBM-3279-2-E ff f0   ← ここで端末タイプを送る
```

**`DO NEW-ENVIRON` は端末タイプを送るより前に来る。**
つまり端末タイプを組み立てる時点で「IBM i かどうか」は分かっている。

⚠ ただし**順序は仕様で保証されたものではない**。実測（実機）ではこの順。
逆順のホストが出たら `@名前` を付けてしまうので、そのときは測って直す。

## B. `@名前` は TK4- の流儀（既存の実測）

`telnet.ts` の注記いわく「基本 TN3270 の慣行（実測で Hercules が受理）」。
TK4- 向けの試験がこれに依存している。**そちらは壊せない。**

## C. IBM i は `DEVNAME` で受け取る

`sendEnviron` は `DEVNAME` / `KBDTYPE` / `CODEPAGE` / `CHARSET` を送る。
5250 側の実機知見でここは既に正しい。**足りないのは「`@名前` を付けない」だけ。**

## D. 見分けは前の工程のものを使う

`Tn3270Session.isIbmI`（＝ NEW-ENVIRON を交渉したか）。
ただし**端末タイプを送るのは telnet 層**なので、層の中で持っている
`sawNewEnviron` をそのまま使う。

いまは `SB NEW-ENVIRON SEND` を受けた時点で立てている。**`DO NEW-ENVIRON` の
時点でも立てる**ようにする——A のとおり DO の方が早く、端末タイプに間に合う。

## E. 決めたこと

1. `sawNewEnviron` は **`DO NEW-ENVIRON` でも立てる**（早い方に合わせる）
2. `sendTerminalType` は **NEW-ENVIRON を交渉したホストには `@名前` を付けない**
3. サーバーは `deviceName` を素通しする（保存済み設定・直指定の両方）
4. 名前が使用中のときの扱いは**この工程では触らない**（要求が出てから）
