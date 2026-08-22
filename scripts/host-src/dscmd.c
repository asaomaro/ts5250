/*
 * **5250 の任意のコマンドを実機から発行させる。**
 *
 * `.aidev/backlog/datastream-commands.md` の未実装項目は「実機で届かないので確かめられない」で
 * 止まっていた。だが **IBM 自身が発行する API を出荷している**——動的画面管理（DSM）。
 * `QSYSINC/H(QSNAPI)` を読むと、欲しいコマンドがひととおり揃っている:
 *
 *     QsnRollUp / QsnRollDown   → ROLL(0x23)
 *     QsnReadImm                → READ IMMEDIATE(0x72)
 *     QsnReadMDTImmAlt          → READ MDT IMMEDIATE ALT(0x83)
 *
 * 呼び出し: CALL TESTLIB/DSCMD PARM('ROLLUP')
 *
 * 経過は IFS のログへ書く。画面へ printf すると DSM と混ざるうえ、落ちたときに何も残らない。
 *
 * ⚠ **型に注意。** `Q_Bin4` は `long`、`Q_Handle_T` も `long`。
 *   `int` で受けると CZM0280、ハンドルに `NULL` を渡しても CZM0280。`0` を渡す。
 *
 * ビルド: scripts/build-dscmd.mjs
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <qsnapi.h>

static FILE *lg;

/** 帰還域を用意する（先頭 4 バイトに長さ＝例外ではなく戻り値で返す） */
static void inzFdbk(char *f, int n) {
    memset(f, 0, n);
    *(Q_Bin4 *)f = (Q_Bin4)n;
}

/** 帰還域に入ったメッセージ ID（7 文字）。空なら成功 */
static void logFdbk(const char *what, Q_Bin4 rc, const char *f) {
    if (!lg) return;
    fprintf(lg, "%s rc=%d fdbk_bytes=%d msg=%.7s\n",
            what, (int)rc, (int)*(Q_Bin4 *)(f + 4), f + 8);
    fflush(lg);
}

int main(int argc, char *argv[]) {
    char fdbk[256];
    char what[32];
    Qsn_Inp_Buf_T buf = 0;
    Q_Bin4 bytesRead = 0;
    Q_Bin4 rc = -1;

    lg = fopen(DSCMD_LOG, "w");
    memset(what, 0, sizeof(what));
    if (argc > 1) {
        strncpy(what, argv[1], sizeof(what) - 1);
        /* CL の PARM は空白詰めで来る */
        { char *p = what + strlen(what); while (p > what && *(p - 1) == ' ') *--p = 0; }
    }
    if (lg) { fprintf(lg, "start what=[%s]\n", what); fflush(lg); }

    if (strcmp(what, "ROLLUP") == 0 || strcmp(what, "ROLLDOWN") == 0) {
        /*
         * **引数は (行数, 上端, 下端)。** 最初 (上端, 下端, 行数) の順だと思って
         * `QsnRollUp(2,20,3)` を渡し、`CPFA315 ロール・パラメーターが正しくない` で落ちた。
         * メッセージ本文が「行数 &1, 最上行 &2, 最下行 &3」と言っているので順が確定した。
         *
         * **3 つとも別の値を渡す**——どの引数がどのバイトになるかを実測するため。
         * 当方の実装は `方向＋行数(1) 上端(1) 下端(1)` と読む（SC30-3533 / tn5250）ので、
         * 行数 3 / 上端 2 / 下端 20(0x14) なら `04 23 03 02 14`（下方向なら 0x83）になるはず。
         */
        inzFdbk(fdbk, sizeof(fdbk));
        if (strcmp(what, "ROLLUP") == 0) {
            rc = QsnRollUp(3, 2, 20, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnRollUp(lines=3,top=2,bottom=20)", rc, fdbk);
        } else {
            rc = QsnRollDown(3, 2, 20, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnRollDown(lines=3,top=2,bottom=20)", rc, fdbk);
        }
    } else if (strcmp(what, "READIMM") == 0 || strcmp(what, "READIMMALT") == 0) {
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnCrtInpBuf", (Q_Bin4)buf, fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            if (strcmp(what, "READIMM") == 0) {
                rc = QsnReadImm(&bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnReadImm", rc, fdbk);
            } else {
                /* **0x83。当方は応答していない**——ホストが待つかどうかがここで分かる */
                rc = QsnReadMDTImmAlt(&bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnReadMDTImmAlt", rc, fdbk);
            }
            if (lg) { fprintf(lg, "bytesRead=%d\n", (int)bytesRead); fflush(lg); }
            /*
             * **ホストが何を読み取れたか**を見る。`bytesRead` が 0x72 と 0x83 で桁違いだったので、
             * 応答の形式が合っているかを欄の数と中身で確かめる。
             */
            {
                /*
                 * 宣言はヘッダーどおり（推測で引数を並べて CRTBNDC を 1 回落とした）:
                 *   Q_Bin4 QsnRtvFldCnt   (Qsn_Inp_Buf_T, Q_Bin4 *, Q_Fdbk_T *)
                 *   Q_Bin4 QsnRtvReadLen  (Qsn_Inp_Buf_T, Q_Bin4 *, Q_Fdbk_T *)
                 *   Q_Bin4 QsnRtvFldDtaLen(Qsn_Inp_Buf_T, Q_Bin4 *, Q_Fdbk_T *)
                 *   char  *QsnRtvDta      (Qsn_Inp_Buf_T, char **,  Q_Fdbk_T *)
                 */
                Q_Bin4 cnt = -1, rlen = -1, dlen = -1;
                char *dta = 0;
                inzFdbk(fdbk, sizeof(fdbk));
                QsnRtvFldCnt(buf, &cnt, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnRtvFldCnt", cnt, fdbk);
                inzFdbk(fdbk, sizeof(fdbk));
                QsnRtvReadLen(buf, &rlen, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnRtvReadLen", rlen, fdbk);
                inzFdbk(fdbk, sizeof(fdbk));
                QsnRtvFldDtaLen(buf, &dlen, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnRtvFldDtaLen", dlen, fdbk);
                inzFdbk(fdbk, sizeof(fdbk));
                dta = QsnRtvDta(buf, (char **)0, (Q_Fdbk_T *)fdbk);
                if (lg) {
                    fprintf(lg, "dta=[%.60s]\n", dta ? dta : "(null)");
                    fflush(lg);
                }
            }
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "PRTSCR") == 0) {
        /*
         * **READ SCREEN TO PRINT(0x66)。** `QsnPutInpCmd` は第 1 引数が
         * **コマンドバイトそのもの**なので、任意の入力コマンドを出せる:
         *
         *   Q_Bin4 QsnPutInpCmd(Q_Uchar cmd, const char *data, Q_Bin4 len,
         *                       Q_Bin4 *bytesRead, Qsn_Inp_Buf_T, Qsn_Cmd_Buf_T,
         *                       Qsn_Env_T, Q_Fdbk_T *);
         */
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnCrtInpBuf", (Q_Bin4)buf, fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutInpCmd(0x66, (const char *)0, 0, &bytesRead,
                              buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutInpCmd(0x66)", rc, fdbk);
            if (lg) { fprintf(lg, "bytesRead=%d\n", (int)bytesRead); fflush(lg); }
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "BADCMD") == 0) {
        /*
         * **未知のコマンド（0xFE）を出す。**
         *
         *   Q_Bin4 QsnPutOutCmd(Q_Uchar cmd, const char *data, Q_Bin4 len,
         *                       Qsn_Cmd_Buf_T, Qsn_Env_T, Q_Fdbk_T *);
         *
         * 当方は「警告して残りを捨てる」だけで負応答を返さない。**ホストが待つのか**を見る。
         */
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0xFE, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0xFE)", rc, fdbk);
    } else {
        if (lg) fprintf(lg, "unknown request\n");
    }

    if (lg) { fprintf(lg, "done\n"); fclose(lg); }
    return 0;
}
