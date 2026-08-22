/*
 * **READ IMMEDIATE(0x72) を実機から発行させる。**
 *
 * IBM i の動的画面管理（DSM）API。`QSYSINC/H(QSNAPI)` に
 *
 *     #define QSN_READ_IMM   0x72
 *     Q_Bin4 QsnReadImm(Q_Bin4 *, Qsn_Inp_Buf_T, Qsn_Cmd_Buf_T, Qsn_Env_T, Q_Fdbk_T *);
 *
 * とあり、**IBM 自身の一次資料で opcode が 0x72 と確定する**。
 *
 * 経過は IFS のログへ書く。画面へ printf すると DSM と混ざるうえ、落ちたときに何も残らない。
 *
 * ⚠ **型に注意。** `Q_Bin4` は `long`、`Q_Handle_T` も `long`。
 *   `int` で受けると CZM0280（long* と int* は代入できない）、
 *   ハンドルに `NULL` を渡すと CZM0280（long と void* は代入できない）。
 *
 * ビルド: scripts/build-rdimm.mjs
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <qsnapi.h>

static FILE *lg;
#define LOG(fmt, a, b, c) do { if (lg) { fprintf(lg, fmt, a, b, c); fflush(lg); } } while (0)

int main(void) {
    Qsn_Inp_Buf_T buf = 0;
    Q_Bin4 bytesRead = 0;
    Q_Bin4 rc = -1;
    Q_Bin4 len = -1;
    char fdbk[256];

    lg = fopen(RDIMM_LOG, "w");
    if (lg) { fprintf(lg, "start\n"); fflush(lg); }

    /* 帰還域: 先頭 4 バイトに長さを入れると、例外ではなく戻り値で返る */
    memset(fdbk, 0, sizeof(fdbk));
    *(Q_Bin4 *)fdbk = (Q_Bin4)sizeof(fdbk);

    buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
    LOG("QsnCrtInpBuf handle=%d fdbk_bytes=%d msg=%.7s\n",
        (int)buf, (int)*(Q_Bin4 *)(fdbk + 4), fdbk + 8);
    if (buf == 0) { if (lg) { fprintf(lg, "no buffer\n"); fclose(lg); } return 1; }

    memset(fdbk, 0, sizeof(fdbk));
    *(Q_Bin4 *)fdbk = (Q_Bin4)sizeof(fdbk);

    /* **ここでホストが ESC 0x72 を送る** */
    rc = QsnReadImm(&bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
    LOG("QsnReadImm rc=%d bytesRead=%d fdbk_bytes=%d\n",
        (int)rc, (int)bytesRead, (int)*(Q_Bin4 *)(fdbk + 4));
    if (lg) { fprintf(lg, "fdbk_msg=%.7s\n", fdbk + 8); fflush(lg); }

    QsnRtvBufLen(buf, &len, (Q_Fdbk_T *)0);
    if (lg) { fprintf(lg, "buflen=%d\n", (int)len); fflush(lg); }
    QsnDltBuf(buf, (Q_Fdbk_T *)0);
    if (lg) { fprintf(lg, "done\n"); fclose(lg); }
    return 0;
}
