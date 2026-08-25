/*
 * **5250 の任意のコマンドを実機から発行させる。**
 *
 * `.aidev/backlog/datastream-commands.md` の未実装項目は「実機で届かないので確かめられない」で
 * 止まっていた。だが **IBM 自身が発行する API を出荷している**——動的画面管理（DSM）。
 * `QSYSINC/H(QSNAPI)` を読むと、欲しいコマンドがひととおり揃っている:
 *
 *     QsnRollUp / QsnRollDown   → ROLL(0x23)
 *     QsnReadInp                → READ INPUT FIELDS(0x42)
 *     QsnReadImm                → READ IMMEDIATE(0x72)
 *     QsnReadMDTImmAlt          → READ MDT IMMEDIATE ALT(0x83)
 *     QsnPutOutCmd(cmd,…)       → 任意の出力コマンド（CLEAR UNIT ALTERNATE(0x20) 等）
 *
 * 呼び出し: CALL ASAOLIB/DSCMD PARM('ROLLUP')
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

/**
 * **ログの見出し。** 同じ API を 2 回呼ぶ要求（0x42 のあとに 0x72）で、どちらの結果かを
 * 区別できるようにする。`logFdbk` が頭に付ける。
 */
static const char *tag = "";

/** 帰還域に入ったメッセージ ID（7 文字）。空なら成功 */
static void logFdbk(const char *what, Q_Bin4 rc, const char *f) {
    if (!lg) return;
    fprintf(lg, "%s%s rc=%d fdbk_bytes=%d msg=%.7s\n",
            tag, what, (int)rc, (int)*(Q_Bin4 *)(f + 4), f + 8);
    fflush(lg);
}

/** 16 進ダンプ。**応答の生バイトがホストに何と読まれたか**を見るのが目的 */
static void logHex(const char *what, const char *p, int n) {
    int i;
    char here[16];
    if (!lg) return;
    if (p == 0) { fprintf(lg, "%s%s len=%d hex=(null)\n", tag, what, n); fflush(lg); return; }
    if (n < 0) n = 0;
    if (n > 96) n = 96;
    fprintf(lg, "%s%s len=%d hex=", tag, what, n);
    for (i = 0; i < n; i++) {
        sprintf(here, "%02x", (unsigned char)p[i]);
        fprintf(lg, "%s", here);
    }
    fprintf(lg, "\n");
    fflush(lg);
}

/**
 * **応用プログラムの立場で欄データを切り分ける。**
 *
 * `0x42` / `0x72` の応答には SBA が無い（原典 GNU tn5250 `session.c` の
 * `CMD_READ_INPUT_FIELDS` / `CMD_READ_IMMEDIATE` の枝）。ホストは欄の分解を
 * 提供しない（`QsnRtvFldCnt` は CPFA32E）ので、**呼び出し側が欄長で切る**しかない。
 * 試験画面の欄長は 10 / 6 / 8 なので、合計 24 バイトに切れるはずである。
 */
static void logSlice(const char *fdta, int flen) {
    static const int lens[3] = { 10, 6, 8 };
    int i, off = 0, n;
    char here[16];
    if (!lg) return;
    fprintf(lg, "%s欄長 10/6/8 で切ると（応用プログラムの見え方）: 全長=%d 期待=24\n", tag, flen);
    for (i = 0; i < 3; i++) {
        n = lens[i];
        fprintf(lg, "%s  切片%d len=%d hex=", tag, i + 1, n);
        if (fdta == 0) { fprintf(lg, "(null)\n"); continue; }
        for (; n > 0; n--, off++) {
            if (off >= flen) { fprintf(lg, "--"); continue; }
            sprintf(here, "%02x", (unsigned char)fdta[off]);
            fprintf(lg, "%s", here);
        }
        fprintf(lg, "\n");
    }
    fflush(lg);
}

/**
 * **入力バッファに何が入ったかを余さず記録する。**
 *
 * `bytesRead` だけでは「素通しで返しただけ」か「**構造として分解できた**」かが分からない
 * （監査の指摘そのもの）。`QsnRtvFldCnt` / `QsnRtvFldInf` は**欄の数と欄ごとの行・桁・長さ・値**を
 * 返すので、ここが合っていればホストは応答を構造として読めている。
 */
static void logInpBuf(Qsn_Inp_Buf_T buf) {
    char fdbk[256];
    Q_Bin4 cnt = -1, rlen = -1, dlen = -1, flen = -1;
    Q_Bin4 row = -1, col = -1;
    Q_Uchar aid = 0;
    char *dta = 0;
    char *fdta = 0;
    int i;

    if (!lg) return;

    inzFdbk(fdbk, sizeof(fdbk));
    QsnRtvReadLen(buf, &rlen, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnRtvReadLen", rlen, fdbk);

    inzFdbk(fdbk, sizeof(fdbk));
    QsnRtvReadAdr(buf, &row, &col, 0, (Q_Fdbk_T *)fdbk);
    fprintf(lg, "%sQsnRtvReadAdr row=%d col=%d msg=%.7s\n", tag, (int)row, (int)col, fdbk + 8);

    inzFdbk(fdbk, sizeof(fdbk));
    aid = QsnRtvReadAID(buf, (Q_Uchar *)0, (Q_Fdbk_T *)fdbk);
    fprintf(lg, "%sQsnRtvReadAID aid=%02x msg=%.7s\n", tag, (unsigned)aid, fdbk + 8);

    inzFdbk(fdbk, sizeof(fdbk));
    QsnRtvDtaLen(buf, &dlen, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnRtvDtaLen", dlen, fdbk);
    inzFdbk(fdbk, sizeof(fdbk));
    dta = QsnRtvDta(buf, (char **)0, (Q_Fdbk_T *)fdbk);
    logHex("QsnRtvDta", dta, (int)dlen);

    inzFdbk(fdbk, sizeof(fdbk));
    QsnRtvFldDtaLen(buf, &flen, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnRtvFldDtaLen", flen, fdbk);
    inzFdbk(fdbk, sizeof(fdbk));
    fdta = QsnRtvFldDta(buf, (char **)0, (Q_Fdbk_T *)fdbk);
    logHex("QsnRtvFldDta", fdta, (int)flen);

    inzFdbk(fdbk, sizeof(fdbk));
    QsnRtvFldCnt(buf, &cnt, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnRtvFldCnt", cnt, fdbk);
    if (cnt < 0) logSlice(fdta, (int)flen);

    /*
     * **欄ごとの行・桁・長さ・値。** ここが打った値と一致すれば「ホストが正しく読めた」、
     * ずれるなら不具合。`Qsn_Fld_Inf_T` は _Packed なのでポインタは memcpy で取り出す。
     */
    for (i = 1; i <= (int)cnt && i <= 8; i++) {
        Qsn_Fld_Inf_T fi;
        char *p = 0;
        memset(&fi, 0, sizeof(fi));
        inzFdbk(fdbk, sizeof(fdbk));
        QsnRtvFldInf(buf, (Q_Bin4)i, &fi, (Q_Bin4)sizeof(fi), 0, (Q_Fdbk_T *)fdbk);
        fprintf(lg, "%sfld[%d] type=%c row=%d col=%d len=%d ret=%d avail=%d msg=%.7s\n",
                tag, i, fi.type ? fi.type : '?', (int)fi.row, (int)fi.col, (int)fi.len,
                (int)fi.bytes_returned, (int)fi.bytes_available, fdbk + 8);
        memcpy(&p, &fi.data, sizeof(p));
        logHex("  flddta", p, (int)fi.len);
    }
}

/**
 * **入力欄 3 つの試験画面を書く。**
 *
 * 0x42 / 0x72 の応答を突き合わせるには、**欄の位置と長さがこちらで分かっている画面**が要る。
 * DSM の `QsnSetFld` は引数の並びを推測するしかないので、**生の WRITE TO DISPLAY を
 * `QsnPutOutCmd(0x11, …)` でそのまま出す**（第 1 引数がコマンドバイトなので何でも出せる）。
 *
 *   (5,10)-(5,19) 長さ10 / (7,10)-(7,15) 長さ6 / (9,10)-(9,17) 長さ8
 *
 * 欄の直前の桁に属性 0x20（緑・通常）を置く（5250 の欄は属性 1 桁を先頭に持つ）。
 */
static void putTestScreen(void) {
    char fdbk[256];
    Q_Bin4 rc;
    static const unsigned char wtd[] = {
        0x00, 0x00,                         /* CC1 / CC2 */
        0x11, 0x03, 0x02,                   /* SBA(3,2) */
        0xD9, 0xC5, 0xC1, 0xC4, 0xC9, 0xD5, 0xD7,   /* "READINP"（EBCDIC） */
        0x11, 0x05, 0x09,                   /* SBA(5,9) */
        0x1D, 0x40, 0x00, 0x20, 0x00, 0x0A, /* SF FFW=4000 attr=20 len=10 → (5,10) */
        0x11, 0x07, 0x09,
        0x1D, 0x40, 0x00, 0x20, 0x00, 0x06, /* → (7,10) 長さ6 */
        0x11, 0x09, 0x09,
        0x1D, 0x40, 0x00, 0x20, 0x00, 0x08, /* → (9,10) 長さ8 */
        0x13, 0x05, 0x0A                    /* IC(5,10) */
    };
    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x11, (const char *)wtd, (Q_Bin4)sizeof(wtd), 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x11 試験画面)", rc, fdbk);
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
    } else if (strcmp(what, "READINP") == 0 || strcmp(what, "READINPIMM") == 0) {
        /*
         * **READ INPUT FIELDS(0x42)。**
         *
         *   Q_Bin4 QsnReadInp(Q_Uchar cc1, Q_Uchar cc2, Q_Bin4 *bytesRead,
         *                     Qsn_Inp_Buf_T, Qsn_Cmd_Buf_T, Qsn_Env_T, Q_Fdbk_T *);
         *
         * 0x72/0x83 と違い**利用者の AID を待つ**（原典 tn5250 も `aidcode != 0` を assert する）。
         * 位置と長さの分かっている試験画面を先に書いてから読むので、**打った値と
         * ホストが受け取った値をそのまま突き合わせられる**。
         *
         * `READINPIMM` は続けて `QsnReadImm`(0x72) も出す——0x42 で MDT が立った直後の
         * 画面をそのまま使えるので、**0x72 の応答が構造として読めるか**まで一度に見られる。
         */
        static const char cc42[2] = { 0x00, 0x00 };
        putTestScreen();
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(4096, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnCrtInpBuf", (Q_Bin4)buf, fdbk);
        if (buf != 0) {
            /* **対照**: 普段どおりの READ MDT FIELDS(0x52)。ここが通れば引数の並びは正しい */
            tag = "[0x52 対照] ";
            bytesRead = 0;
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT(cc1=00,cc2=00)", rc, fdbk);
            if (lg) { fprintf(lg, "%sbytesRead=%d\n", tag, (int)bytesRead); fflush(lg); }
            logInpBuf(buf);

            /* **API 経由の 0x42。** 装置が対応していないと CPFA306 で出ない */
            tag = "[0x42 API] ";
            inzFdbk(fdbk, sizeof(fdbk));
            QsnClrBuf((Q_Handle_T)buf, (Q_Fdbk_T *)fdbk);
            bytesRead = 0;
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadInp(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadInp(cc1=00,cc2=00)", rc, fdbk);
            if (lg) { fprintf(lg, "%sbytesRead=%d\n", tag, (int)bytesRead); fflush(lg); }
            logInpBuf(buf);

            /* **生で 0x42 を出す。** `QsnPutInpCmd` は第 1 引数がコマンドバイトそのもの */
            tag = "[0x42 生] ";
            inzFdbk(fdbk, sizeof(fdbk));
            QsnClrBuf((Q_Handle_T)buf, (Q_Fdbk_T *)fdbk);
            bytesRead = 0;
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutInpCmd(0x42, cc42, 2, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutInpCmd(0x42)", rc, fdbk);
            if (lg) { fprintf(lg, "%sbytesRead=%d\n", tag, (int)bytesRead); fflush(lg); }
            logInpBuf(buf);

            if (strcmp(what, "READINPIMM") == 0) {
                tag = "[0x72] ";
                inzFdbk(fdbk, sizeof(fdbk));
                QsnClrBuf((Q_Handle_T)buf, (Q_Fdbk_T *)fdbk);
                bytesRead = 0;
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnReadImm(&bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnReadImm", rc, fdbk);
                if (lg) { fprintf(lg, "%sbytesRead=%d\n", tag, (int)bytesRead); fflush(lg); }
                logInpBuf(buf);
            }
            tag = "";
            QsnDltBuf((Q_Handle_T)buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "WINCUA") == 0) {
        /*
         * **窓を出したまま CLEAR UNIT ALTERNATE(0x20) を撃つ。**
         *
         * 当方は CUA で GUI 構造体（窓）を消さない。参照実装 2 つは窓を閉じる。
         * 「窓が残って残骸になるか」を実機で見るために、
         *
         *   1. 背景を書く
         *   2. CREATE WINDOW(WDSF 0xD9/0x51) で窓を出す
         *   3. **READ MDT で止める**（ここで観測点 1）
         *   4. `QsnPutOutCmd(0x20, パラメータ 1 バイト)` で CUA
         *   5. 目印を書いて **READ MDT で止める**（ここで観測点 2）
         *
         * を順に出す。3 と 5 で `Enter` を返してもらう前提。
         */
        static const unsigned char bg[] = {
            0x00, 0x00,
            0x11, 0x02, 0x02,
            0xC2, 0xC1, 0xC3, 0xD2, 0xC7, 0xD9, 0xD6, 0xE4, 0xD5, 0xC4  /* "BACKGROUND" */
        };
        static const unsigned char win[] = {
            0x00, 0x00,
            0x11, 0x05, 0x0A,                   /* SBA(5,10) */
            0x15, 0x00, 0x16,                   /* WDSF LL=22 */
            0xD9, 0x51,                         /* CREATE WINDOW */
            0x00, 0x00, 0x00,                   /* flag1 / 予約 2 */
            0x05, 0x14,                         /* 深さ 5 / 幅 20 */
            0x05, 0x01, 0x80, 0x38, 0x38,       /* 境界（色だけの短い形） */
            0x08, 0x10, 0x00, 0x00, 0x00, 0x00, 0xE6, 0xD5  /* 見出し "WN" */
        };
        static const unsigned char after[] = {
            0x00, 0x00,
            0x11, 0x02, 0x02,
            0xC1, 0xC6, 0xE3, 0xC5, 0xD9, 0x40, 0xC3, 0xE4, 0xC1  /* "AFTER CUA" */
        };
        static const char cuaParm[1] = { 0x00 };

        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)bg, (Q_Bin4)sizeof(bg), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 背景)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)win, (Q_Bin4)sizeof(win), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 CREATE WINDOW)", rc, fdbk);

        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnCrtInpBuf", (Q_Bin4)buf, fdbk);
        if (buf != 0) {
            tag = "[窓あり] ";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);

            tag = "";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x20, cuaParm, 1, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x20 CLEAR UNIT ALTERNATE)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, (const char *)after, (Q_Bin4)sizeof(after), 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 目印)", rc, fdbk);

            tag = "[CUA 後] ";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            tag = "";
            QsnDltBuf((Q_Handle_T)buf, (Q_Fdbk_T *)0);
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
