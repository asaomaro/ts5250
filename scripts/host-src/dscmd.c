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
#include <unistd.h>
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

/**
 * **ROLL で空いた行を見るための試験**（`20260921-roll-vacated-rows`）。行 1〜24 に行番号を書いた画面を出し、
 * 行 2〜20 を 3 行ロールしてから 8 秒待つ（待つ間に端末の画面を採る。プログラムが終わるとホストが画面を描き直す）。
 * 空いた行（上ロールなら 18〜20、下ロールなら 2〜4）に何が残るかが、ACS と当 PJ で違うかを測る。
 */
static void rollTest(int up) {
    char fdbk[256];
    char wtd[24 * 12 + 8];
    int n = 0, r;
    Q_Bin4 rc;
    /* ESC WTD CC1 CC2 のうち ESC は QsnPutOutCmd が付けるので、WTD の本体（CC1 CC2 ＋オーダー）だけを渡す */
    wtd[n++] = 0x00; wtd[n++] = 0x00;
    for (r = 1; r <= 24; r++) {
        /* SBA(r,2) "ROW rr"（EBCDIC: R=D9 O=D6 W=E6 空白=40 数字=F0+） */
        wtd[n++] = 0x11; wtd[n++] = (char)r; wtd[n++] = 0x02;
        wtd[n++] = (char)0xD9; wtd[n++] = (char)0xD6; wtd[n++] = (char)0xE6; wtd[n++] = 0x40;
        wtd[n++] = (char)(0xF0 + r / 10); wtd[n++] = (char)(0xF0 + r % 10);
    }
    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x11, (const char *)wtd, (Q_Bin4)n, 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x11 行番号の画面)", rc, fdbk);
    inzFdbk(fdbk, sizeof(fdbk));
    rc = up ? QsnRollUp(3, 2, 20, 0, 0, (Q_Fdbk_T *)fdbk) : QsnRollDown(3, 2, 20, 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk(up ? "QsnRollUp(3,2,20)" : "QsnRollDown(3,2,20)", rc, fdbk);
    sleep(8);
}

/**
 * **WRITE ERROR CODE TO WINDOW(0x22) を出す**（`20260926-window-error-code`）。
 *
 * 台帳は「0x22 は実機で観測できていない」で保留していたが、`QsnPutOutCmd` の第 1 引数はコマンドバイトそのものなので、
 * 窓を開いた画面に 0x22 を当てれば ACS のコア（`acs-probe`）と当 PJ を同じ条件で比べられる。
 *
 *   1. 背景（行 2 と最下行＝既定のメッセージ行に目印）を書く
 *   2. CREATE WINDOW（5,10・深さ 5・幅 20）で窓を出す
 *   3. `QsnPutOutCmd(0x22, 開始桁 12・終了桁 29・本文)` を撃つ
 *   4. **READ MDT で止める**（ここで観測。Reset → Enter で抜ける前提）
 *
 * `longMsg` のときは本文を桁範囲（18 桁）より長くする（30 字）——ACS が範囲で切るかを見る。
 * `row22` のときは背景の WTD の先頭に SOH（エラー行＝22）を置く。最下行（既定）だと ACS は開始桁を捨てて行頭から書くので
 * （書き始め＋桁数が画面の大きさを超えれば行頭へ戻す）、最下行以外で開始桁が効くかを別に見る。
 * 本文の先頭は属性 0x22（高輝度）。文字は EBCDIC の 16 進で書く（ソースの文字コードに左右されないため）。
 */
static void winErrTest(int longMsg, int row22) {
    char fdbk[256];
    Q_Bin4 rc;
    Q_Bin4 bytesRead = 0;
    Qsn_Inp_Buf_T buf;
    static const unsigned char bg[] = {
        0x00, 0x00,
        0x11, 0x02, 0x02,
        0xC2, 0xC1, 0xC3, 0xD2, 0xC7, 0xD9, 0xD6, 0xE4, 0xD5, 0xC4,        /* "BACKGROUND" */
        0x11, 0x18, 0x02,                                                  /* SBA(24,2)＝既定のメッセージ行 */
        0xD4, 0xE2, 0xC7, 0xD3, 0xC9, 0xD5, 0xC5, 0x40, 0xD6, 0xD9, 0xC9, 0xC7, 0xC9, 0xD5, 0xC1, 0xD3,
        0x40, 0xE3, 0xC5, 0xE7, 0xE3, 0x40, 0xE3, 0xD6, 0x40, 0xC2, 0xC5, 0x40, 0xD9, 0xC5, 0xE2, 0xE3,
        0xD6, 0xD9, 0xC5, 0xC4                                             /* "MSGLINE ORIGINAL TEXT TO BE RESTORED" */
    };
    /* SOH（長さ 4: フラグ・予約・再順序・エラー行＝22）＋ 行 22 の目印 */
    static const unsigned char bg22[] = {
        0x00, 0x00,
        0x01, 0x04, 0x00, 0x00, 0x00, 0x16,
        0x11, 0x02, 0x02,
        0xC2, 0xC1, 0xC3, 0xD2, 0xC7, 0xD9, 0xD6, 0xE4, 0xD5, 0xC4,        /* "BACKGROUND" */
        0x11, 0x16, 0x02,                                                  /* SBA(22,2)＝申告したメッセージ行 */
        0xD4, 0xE2, 0xC7, 0xD3, 0xC9, 0xD5, 0xC5, 0x40, 0xD6, 0xD9, 0xC9, 0xC7, 0xC9, 0xD5, 0xC1, 0xD3,
        0x40, 0xE3, 0xC5, 0xE7, 0xE3, 0x40, 0xE3, 0xD6, 0x40, 0xC2, 0xC5, 0x40, 0xD9, 0xC5, 0xE2, 0xE3,
        0xD6, 0xD9, 0xC5, 0xC4
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
    /* 開始桁 12・終了桁 29・属性 0x22・本文 "ERR IN WINDOW" */
    static const unsigned char err[] = {
        0x0C, 0x1D, 0x22,
        0xC5, 0xD9, 0xD9, 0x40, 0xC9, 0xD5, 0x40, 0xE6, 0xC9, 0xD5, 0xC4, 0xD6, 0xE6
    };
    /* 開始桁 12・終了桁 29・属性 0x22・本文 "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"（30 字） */
    static const unsigned char errLong[] = {
        0x0C, 0x1D, 0x22,
        0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9,
        0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xF1, 0xF2, 0xF3, 0xF4
    };

    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
    inzFdbk(fdbk, sizeof(fdbk));
    if (row22) rc = QsnPutOutCmd(0x11, (const char *)bg22, (Q_Bin4)sizeof(bg22), 0, 0, (Q_Fdbk_T *)fdbk);
    else rc = QsnPutOutCmd(0x11, (const char *)bg, (Q_Bin4)sizeof(bg), 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x11 背景)", rc, fdbk);
    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x11, (const char *)win, (Q_Bin4)sizeof(win), 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x11 CREATE WINDOW)", rc, fdbk);
    inzFdbk(fdbk, sizeof(fdbk));
    if (longMsg) rc = QsnPutOutCmd(0x22, (const char *)errLong, (Q_Bin4)sizeof(errLong), 0, 0, (Q_Fdbk_T *)fdbk);
    else rc = QsnPutOutCmd(0x22, (const char *)err, (Q_Bin4)sizeof(err), 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x22 WRITE ERROR CODE TO WINDOW)", rc, fdbk);

    inzFdbk(fdbk, sizeof(fdbk));
    buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnCrtInpBuf", (Q_Bin4)buf, fdbk);
    if (buf != 0) {
        tag = "[0x22 後] ";
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnReadMDT", rc, fdbk);
        tag = "";
        QsnDltBuf((Q_Handle_T)buf, (Q_Fdbk_T *)0);
    }
}

/**
 * **WRITE ERROR CODE(0x21) をメッセージ行で出す**（`20260926-wec-msgline-row`）。
 *
 * ACS は 0x21 も SOH が申告したメッセージ行に書く（`DS5250.processWriteErrorCode`）。当 PJ は最下行に重ねていた。
 *   1. 背景（`row22` なら先頭に SOH でエラー行＝22 を申告）と、メッセージ行・その下の行に目印を書く
 *   2. `QsnPutOutCmd(0x21, 属性 0x22・本文)` を撃つ
 *   3. READ MDT で止める（Reset → Enter で抜ける前提）
 * `longMsg` のときは本文を 1 行（80 桁）より長くする（90 字）——ACS が次の行へ続けて書くかを見る。
 */
static void wecTest(int longMsg, int row22) {
    char fdbk[256];
    Q_Bin4 rc;
    Q_Bin4 bytesRead = 0;
    Qsn_Inp_Buf_T buf;
    unsigned char bg[160];
    int n = 0, i;
    unsigned char row = row22 ? 0x16 : 0x18;
    unsigned char err[1 + 90];
    int en = 0;
    static const unsigned char mark[] = {                      /* "MSGLINE ORIGINAL TEXT TO BE RESTORED" */
        0xD4, 0xE2, 0xC7, 0xD3, 0xC9, 0xD5, 0xC5, 0x40, 0xD6, 0xD9, 0xC9, 0xC7, 0xC9, 0xD5, 0xC1, 0xD3,
        0x40, 0xE3, 0xC5, 0xE7, 0xE3, 0x40, 0xE3, 0xD6, 0x40, 0xC2, 0xC5, 0x40, 0xD9, 0xC5, 0xE2, 0xE3,
        0xD6, 0xD9, 0xC5, 0xC4
    };
    static const unsigned char below[] = {                     /* "NEXT ROW TEXT" */
        0xD5, 0xC5, 0xE7, 0xE3, 0x40, 0xD9, 0xD6, 0xE6, 0x40, 0xE3, 0xC5, 0xE7, 0xE3
    };
    static const unsigned char msg[] = {                       /* "ERROR ON MSGLINE" */
        0xC5, 0xD9, 0xD9, 0xD6, 0xD9, 0x40, 0xD6, 0xD5, 0x40, 0xD4, 0xE2, 0xC7, 0xD3, 0xC9, 0xD5, 0xC5
    };
    static const unsigned char alpha[] = {                     /* "ABCDEFGHIJKLMNOPQRSTUVWXYZ" */
        0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xD1, 0xD2, 0xD3, 0xD4,
        0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9
    };

    bg[n++] = 0x00; bg[n++] = 0x00;
    if (row22) { bg[n++] = 0x01; bg[n++] = 0x04; bg[n++] = 0x00; bg[n++] = 0x00; bg[n++] = 0x00; bg[n++] = 0x16; }
    bg[n++] = 0x11; bg[n++] = row; bg[n++] = 0x02;
    for (i = 0; i < (int)sizeof(mark); i++) bg[n++] = mark[i];
    if (row22) {                                               /* メッセージ行の次の行（23）に目印——長い本文が続けて書くかを見る */
        bg[n++] = 0x11; bg[n++] = 0x17; bg[n++] = 0x02;
        for (i = 0; i < (int)sizeof(below); i++) bg[n++] = below[i];
    }
    err[en++] = 0x22;
    if (longMsg) { for (i = 0; i < 90; i++) err[en++] = alpha[i % 26]; }
    else { for (i = 0; i < (int)sizeof(msg); i++) err[en++] = msg[i]; }

    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x11, (const char *)bg, (Q_Bin4)n, 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x11 背景)", rc, fdbk);
    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x21, (const char *)err, (Q_Bin4)en, 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x21 WRITE ERROR CODE)", rc, fdbk);

    inzFdbk(fdbk, sizeof(fdbk));
    buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnCrtInpBuf", (Q_Bin4)buf, fdbk);
    if (buf != 0) {
        tag = "[0x21 後] ";
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnReadMDT", rc, fdbk);
        tag = "";
        QsnDltBuf((Q_Handle_T)buf, (Q_Fdbk_T *)0);
    }
}

/*
 * **エラー状態のままメッセージ行へ WTD・RESTORE SCREEN が来たときの見え方**（`20260927-error-msgline-wtd`）。
 * 画面: 5 行 2 桁に BASE・24 行 2 桁に MSGLINE ORIGINAL TEXT TO BE RESTORED → 0x21（ERROR ON MSGLINE）でエラー状態にする。その後:
 * ERRMSGWTD＝WTD で 24 行 2 桁に NEW LINE24 を書く / ERRMSGRST＝0x21 の前に QsnSavScr で退避し、24 行を CHANGED に替えてから 0x21、その後 QsnRstScr で戻す
 * （Reset の後に 24 行が CHANGED…なら RESTORE は即時に書かれて Reset の戻しで上書きされた、MSGLINE ORIGINAL…なら RESTORE は Reset の後に処理された）。
 * 最後に READ MDT で止まる（Reset の前後の見え方を見る）
 */
static void errMsgLineTest(int restore) {
    char fdbk[256];
    Q_Bin4 rc;
    Q_Bin4 bytesRead = 0;
    Qsn_Inp_Buf_T buf;
    Qsn_Inp_Buf_T saved = 0;
    unsigned char bg[96];
    unsigned char err[1 + 16];
    int n = 0, en = 0, i;
    static const unsigned char mark[] = {                      /* "MSGLINE ORIGINAL TEXT TO BE RESTORED" */
        0xD4, 0xE2, 0xC7, 0xD3, 0xC9, 0xD5, 0xC5, 0x40, 0xD6, 0xD9, 0xC9, 0xC7, 0xC9, 0xD5, 0xC1, 0xD3,
        0x40, 0xE3, 0xC5, 0xE7, 0xE3, 0x40, 0xE3, 0xD6, 0x40, 0xC2, 0xC5, 0x40, 0xD9, 0xC5, 0xE2, 0xE3,
        0xD6, 0xD9, 0xC5, 0xC4
    };
    static const unsigned char msg[] = {                       /* "ERROR ON MSGLINE" */
        0xC5, 0xD9, 0xD9, 0xD6, 0xD9, 0x40, 0xD6, 0xD5, 0x40, 0xD4, 0xE2, 0xC7, 0xD3, 0xC9, 0xD5, 0xC5
    };
    static const unsigned char neww[] = { 0x00, 0x00, 0x11, 0x18, 0x02, 0xD5, 0xC5, 0xE6, 0x40, 0xD3, 0xC9, 0xD5, 0xC5, 0xF2, 0xF4 };   /* SBA 24,2 "NEW LINE24" */
    /* 退避の後・0x21 の前に 24 行を替える（RESTORE が即時に書かれたのか、Reset の戻しで上書きされたのかを見分けるため）: SBA 24,2 "CHANGED" */
    static const unsigned char chg[] = { 0x00, 0x00, 0x11, 0x18, 0x02, 0xC3, 0xC8, 0xC1, 0xD5, 0xC7, 0xC5, 0xC4 };

    bg[n++] = 0x00; bg[n++] = 0x00;
    bg[n++] = 0x11; bg[n++] = 0x05; bg[n++] = 0x02; bg[n++] = 0xC2; bg[n++] = 0xC1; bg[n++] = 0xE2; bg[n++] = 0xC5;   /* 5,2 BASE */
    bg[n++] = 0x11; bg[n++] = 0x18; bg[n++] = 0x02;
    for (i = 0; i < (int)sizeof(mark); i++) bg[n++] = mark[i];
    err[en++] = 0x22;
    for (i = 0; i < (int)sizeof(msg); i++) err[en++] = msg[i];

    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x11, (const char *)bg, (Q_Bin4)n, 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x11 背景)", rc, fdbk);
    if (restore) {
        inzFdbk(fdbk, sizeof(fdbk));
        saved = QsnSavScr((Qsn_Inp_Buf_T *)0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnSavScr（値は入力バッファのハンドル。0 が失敗）", (Q_Bin4)saved, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)chg, sizeof(chg), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 24 行を CHANGED に)", rc, fdbk);
    }
    inzFdbk(fdbk, sizeof(fdbk));
    rc = QsnPutOutCmd(0x21, (const char *)err, (Q_Bin4)en, 0, 0, (Q_Fdbk_T *)fdbk);
    logFdbk("QsnPutOutCmd(0x21 WRITE ERROR CODE)", rc, fdbk);
    sleep(4);
    if (restore) {
        if (saved != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnRstScr(saved, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnRstScr", rc, fdbk);
            QsnDltBuf(saved, (Q_Fdbk_T *)0);
        }
    } else {
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)neww, sizeof(neww), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 24 行に NEW LINE24)", rc, fdbk);
    }
    inzFdbk(fdbk, sizeof(fdbk));
    buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
    if (buf != 0) {
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnReadMDT", rc, fdbk);
        QsnDltBuf(buf, (Q_Fdbk_T *)0);
    }
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

    if (strcmp(what, "WEC") == 0 || strcmp(what, "WEC22") == 0 || strcmp(what, "WEC22LONG") == 0) {
        wecTest(strstr(what, "LONG") != 0, strstr(what, "22") != 0);
    } else if (strcmp(what, "WINERR") == 0 || strcmp(what, "WINERRLONG") == 0 || strcmp(what, "WINERR22") == 0 || strcmp(what, "WINERR22LONG") == 0) {
        winErrTest(strstr(what, "LONG") != 0, strstr(what, "22") != 0);
    } else if (strcmp(what, "ROLLTESTUP") == 0 || strcmp(what, "ROLLTESTDOWN") == 0) {
        rollTest(strcmp(what, "ROLLTESTUP") == 0);
    } else if (strcmp(what, "ROLLUP") == 0 || strcmp(what, "ROLLDOWN") == 0) {
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
    } else if (strcmp(what, "WSF72") == 0 || strcmp(what, "WSF72N") == 0 || strcmp(what, "WSF72X") == 0) {
        /*
         * **WSF クラス D9・種類 72 を出し、端末の応答を生で残す**（台帳「WSF D9/72 に応答しない」。`20260921-wsf-d9-72`）。
         * ACS `DS5250.processWSF` は種類 72（長さ 6）に、フラグの 0x40 が立ち次のバイトが 0 なら `D9 72 C0 00` と 3 つの CCSID、
         * それ以外は `D9 72 80 00 03 01 04` を返す（0x80 が立っていれば返さず否定応答の理由を立てる）。
         * WSF はホストが端末の応答を待つ入力コマンドなので `QsnPutInpCmd` で出す。`WSF72` はフラグ 0x40、`WSF72N` は 0x00、
         * `WSF72X` は 0x80（ACS は応答せず否定応答を返す。ホストがそれをどう受けるかを見る）
         */
        static const char wsf72[] = { 0x00, 0x06, (char)0xD9, 0x72, 0x40, 0x00 };
        static const char wsf72n[] = { 0x00, 0x06, (char)0xD9, 0x72, 0x00, 0x00 };
        static const char wsf72x[] = { 0x00, 0x06, (char)0xD9, 0x72, (char)0x80, 0x00 };
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnCrtInpBuf", (Q_Bin4)buf, fdbk);
        if (buf != 0) {
            char *dta = 0;
            Q_Bin4 rlen = -1;
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutInpCmd(0xF3, strcmp(what, "WSF72") == 0 ? wsf72 : strcmp(what, "WSF72X") == 0 ? wsf72x : wsf72n, 6, &bytesRead,
                              buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutInpCmd(0xF3 WSF D9/72)", rc, fdbk);
            if (lg) { fprintf(lg, "bytesRead=%d\n", (int)bytesRead); fflush(lg); }
            inzFdbk(fdbk, sizeof(fdbk));
            QsnRtvReadLen(buf, &rlen, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnRtvReadLen", rlen, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            dta = QsnRtvDta(buf, (char **)0, (Q_Fdbk_T *)fdbk);
            logHex("reply", dta, (int)bytesRead);
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "DBCSBS") == 0) {
        /*
         * **DBCS の欄の先頭で Backspace を押したとき**を測る画面（`20260921-backspace-field-start` の節目の点検の指摘）。
         * ACS `FFT5250.nextNonByPassInputFieldPos` は O（open）の欄では欄の先頭に、J（only）の欄では SO の後ろにカーソルを置く。
         * そこで Backspace を押したときのエラーを端末の側で見る（ホストは Enter まで待つだけ）。
         *   (3,10) SBCS 6 桁 / (5,10) O 12 桁（FCW 8280）/ (7,10) J 12 桁（FCW 8200）
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06,
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0C,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x00, 0x20, 0x00, 0x0C,
            0x13, 0x05, 0x0A
        };
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 DBCS の欄)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "DBCSFE") == 0) {
        /*
         * **DBCS の欄の種類ごとに、Field Exit の「欄の先頭」と ME を測る画面**（`20260921-field-exit-checks` の節目 10 の独立点検 B-S1）。
         * ACS `PS5250.processFieldPlusMinusAndExit` は ME の欄で「カーソルが欄の先頭（`cursorSBA == startPos`）か MDT が無い」ときエラー 0021 にする。
         * 欄の先頭の桁が型ごとに違うかを、ACS のコアで Tab の着地と Field Exit の結果から見る。FFW 4008＝ME。
         *   (3,10) G（FCW 8220）12 桁 / (5,10) O（FCW 8280）12 桁 / (7,10) J（FCW 8200）12 桁 / (9,10) E（FCW 8240）12 桁 / (11,10) SBCS 6 桁（ME）
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x09, 0x1D, 0x40, 0x08, 0x82, 0x20, 0x20, 0x00, 0x0C,
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x08, 0x82, 0x80, 0x20, 0x00, 0x0C,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x08, 0x82, 0x00, 0x20, 0x00, 0x0C,
            0x11, 0x09, 0x09, 0x1D, 0x40, 0x08, 0x82, 0x40, 0x20, 0x00, 0x0C,
            0x11, 0x0B, 0x09, 0x1D, 0x40, 0x08, 0x20, 0x00, 0x06,
            0x13, 0x03, 0x0A
        };
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 DBCS の欄)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "SELFCHK") == 0) {
        /*
         * **自己点検欄（CHECK(M10)）で Field Exit と Tab を比べる画面**（`20260921-field-exit-checks` の節目 10 の独立点検 B-S5）。
         * ACS `processFieldPlusMinusAndExit` は `checkModulusField` を呼ばない（呼ぶのは `moveCursorWithMandFillCheck`〔Tab など〕と `processAIDCode`）。
         *   (3,10) 自己点検欄（FCW B1A0）6 桁 / (5,10) 素の欄 6 桁
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x09, 0x1D, 0x40, 0x00, 0xB1, 0xA0, 0x20, 0x00, 0x06,
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06,
            0x13, 0x03, 0x0A
        };
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 自己点検欄)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "CTLBYTES") == 0) {
        /*
         * **WTD のデータの中に制御バイトを入れる**（R11 の M2）。ACS `processWriteToDisplay` のオーダーは 10 個だけで、それ以外（ESC 以外）は表示データとして書く。
         * 当 PJ は 0x1F と 0x00 以外の制御バイトを「未知のオーダー」として次の ESC まで捨てる。後ろの SBA・SF・IC が生きるかを見る。
         *   (3,3) A<05>B<06>C<07>D<08>E<09> / (4,3) F<0A>G<0B>H<0C>I<0D>J / (5,3) K<16>L<17>M<18>N<19>O<1A>P<1B>Q / (6,3) R<1F>S<00>T
         *   (8,3) "UVW"（SBA の後ろ）/ (10,9) 入力欄 6 桁（SF の後ろ）/ IC (10,10)
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x03, 0xC1, 0x05, 0xC2, 0x06, 0xC3, 0x07, 0xC4, 0x08, 0xC5, 0x09,
            0x11, 0x04, 0x03, 0xC6, 0x0A, 0xC7, 0x0B, 0xC8, 0x0C, 0xC9, 0x0D, 0xD1,
            0x11, 0x05, 0x03, 0xD2, 0x16, 0xD3, 0x17, 0xD4, 0x18, 0xD5, 0x19, 0xD6, 0x1A, 0xD7, 0x1B, 0xD8,
            0x11, 0x06, 0x03, 0xD9, 0x1F, 0xE2, 0x00, 0xE3,
            0x11, 0x08, 0x03, 0xE4, 0xE5, 0xE6,
            0x11, 0x0A, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06,
            0x13, 0x0A, 0x0A
        };
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 制御バイト入りの WTD)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "SBA10") == 0) {
        /*
         * **SBA の行 1・桁 0 から始まる欄**（R11 の M3）。ACS `processWriteToDisplay` は、行 1・桁 0 の SBA のあとにデータ（または SF）が続くなら
         * 番地 -1 として受理する（欄の属性が 1 行 1 桁の直前にある画面のための状態を持つ）。当 PJ は範囲外として例外で捨てる。
         *   SBA(1,0) SF(入力欄 8 桁・属性 0x24) / (3,3) "ABC" / IC (1,1)
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x01, 0x00, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x08,
            0x11, 0x03, 0x03, 0xC1, 0xC2, 0xC3,
            0x13, 0x01, 0x01
        };
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 SBA(1,0) の WTD)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "ROLLBAD") == 0) {
        /*
         * **指定の不正な ROLL を出す**（下端 ≤ 上端。`20260921-negative-responses`）。ACS `processRoll` は -1 を返し、否定応答（0x1005012C）を返す。
         * 出力コマンドなのでホストが待つかどうか・戻りコードが変わるかを見る
         */
        static const char bad[] = { 0x05, 0x0A, 0x05 };
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x23, bad, 3, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x23 不正な ROLL)", rc, fdbk);
    } else if (strcmp(what, "EARLYROLL") == 0) {
        /*
         * **CC2 の効き目が、同じレコードの後ろの否定応答で落ちるか**（`20260927-early-return-cc2`）。
         * 1 本のレコード（コマンド・バッファを QsnPutBuf で 1 回で出す）に「WTD（CC2＝メッセージ待ちを点ける 0x01）＋ 不正な ROLL」を入れる。
         * ACS `processCommand` は不正な ROLL で直ちに戻り、レコードの終わりの `processWCC2` を飛ばす（原典）——点くかを ACS のコアと当 PJ で見る。
         * 前に点いていると区別できないので、先にメッセージ待ちを消す WTD（CC2＝0x02）を出す。
         * レコードの後は 8 秒待つ（状態を見る間）——否定応答を受けたホストは次の入力を CPFA304・出力を CPFA303 で返すので、READ では止まれない（1 回目の実測）。
         * 最後にメッセージ待ちを消す WTD を出して片付ける
         */
        static const unsigned char wtd[] = { 0x00, 0x01, 0x11, 0x05, 0x02,
            0xC5, 0xC1, 0xD9, 0xD3, 0xE8, 0x40, 0xD9, 0xD6, 0xD3, 0xD3 };   /* CC1 0 / CC2 01 / SBA 5,2 "EARLY ROLL" */
        static const char bad[] = { 0x05, 0x0A, 0x05 };
        static const char off[] = { 0x00, 0x02 };
        Qsn_Cmd_Buf_T cb;
        int k;
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, off, 2, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 WTD CC2=02 先に消す)", rc, fdbk);
        sleep(3);
        inzFdbk(fdbk, sizeof(fdbk));
        cb = QsnCrtCmdBuf(256, 0, 0, (Qsn_Cmd_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnCrtCmdBuf", (Q_Bin4)cb, fdbk);
        if (cb == 0) { if (lg) { fprintf(lg, "QsnCrtCmdBuf failed\n"); fclose(lg); } return 1; }   /* 無いと直接出力になり 1 レコードの前提が崩れる */
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)wtd, sizeof(wtd), cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 WTD CC2=01 → バッファ)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x23, bad, 3, cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x23 不正な ROLL → バッファ)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutBuf(cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutBuf（1 本のレコード）", rc, fdbk);
        QsnDltBuf(cb, (Q_Fdbk_T *)0);
        sleep(8);
        for (k = 0; k < 2; k++) {                                  /* 否定応答の後の出力は CPFA303 で返りうる */
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, off, 2, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 WTD CC2=02 メッセージ待ちを消す)", rc, fdbk);
            if (rc == 0) break;
        }
    } else if (strncmp(what, "SHORT", 5) == 0) {
        /*
         * **長さの足りないコマンドで ACS は否定応答（0x10050121）を返して戻るか**（`20260927-short-command-sense`）。
         * 1 本のレコードに「WTD（CC2＝メッセージ待ちを点ける・5 行 2 桁に SHORT）＋ 長さの足りないコマンド（最後に置く）」を入れる。
         * SHORTWTD＝WTD の CC が 1 バイトだけ / SHORTREAD＝READ MDT の CC が 1 バイトだけ / SHORTROLL＝ROLL の 3 バイトのうち 1 バイト /
         * SHORTWEC＝WRITE ERROR CODE の本体が無い / SHORTWECW＝WRITE ERROR CODE TO WINDOW の桁も本体も無い。EARLYROLL と同じく先にメッセージ待ちを消し、8 秒待ってからもう一度消す
         */
        static const unsigned char wtd[] = { 0x00, 0x01, 0x11, 0x05, 0x02, 0xE2, 0xC8, 0xD6, 0xD9, 0xE3 };   /* CC2 01 / SBA 5,2 "SHORT" */
        static const char one[] = { 0x00 };
        static const char off[] = { 0x00, 0x02 };
        Qsn_Cmd_Buf_T cb;
        int k;
        Q_Uchar c = 0x11;
        Q_Bin4 n = 1;
        if (strcmp(what, "SHORTREAD") == 0) c = 0x52;
        else if (strcmp(what, "SHORTROLL") == 0) c = 0x23;
        else if (strcmp(what, "SHORTWEC") == 0) { c = 0x21; n = 0; }
        else if (strcmp(what, "SHORTWECW") == 0) { c = 0x22; n = 0; }
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, off, 2, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 WTD CC2=02 先に消す)", rc, fdbk);
        sleep(3);
        inzFdbk(fdbk, sizeof(fdbk));
        cb = QsnCrtCmdBuf(256, 0, 0, (Qsn_Cmd_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnCrtCmdBuf", (Q_Bin4)cb, fdbk);
        if (cb == 0) { if (lg) { fprintf(lg, "QsnCrtCmdBuf failed\n"); fclose(lg); } return 1; }
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)wtd, sizeof(wtd), cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 WTD CC2=01 → バッファ)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(c, n > 0 ? one : (const char *)0, n, cb, 0, (Q_Fdbk_T *)fdbk);
        if (lg) fprintf(lg, "短いコマンド 0x%02X 長さ %d → ", c, (int)n);
        logFdbk("QsnPutOutCmd（バッファ）", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutBuf(cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutBuf（1 本のレコード）", rc, fdbk);
        QsnDltBuf(cb, (Q_Fdbk_T *)0);
        sleep(8);
        for (k = 0; k < 2; k++) {                                  /* 否定応答の後の出力は CPFA303 で返りうる */
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, off, 2, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 WTD CC2=02 メッセージ待ちを消す)", rc, fdbk);
            if (rc == 0) break;
        }
    } else if (strncmp(what, "WTDERR", 6) == 0) {
        /*
         * **WTD の中のオーダーの誤りで ACS は否定応答を返すか・CC2 は効くか**（`20260927-wtd-order-sense`）。
         * 1 本の WTD（CC2＝メッセージ待ちを点ける・5 行 2 桁に WTDERR）の後ろに誤ったオーダーを置く:
         * WTDERRSBA＝SBA の行 30 / WTDERRRA＝RA の後戻り / WTDERRSOH＝SOH の長さ 0 / WTDERREA＝EA の長さ 7 / WTDERRSHORT＝SBA が 1 バイトで終わる。
         * EARLYROLL と同じく先にメッセージ待ちを消し、8 秒待ってからもう一度消す
         */
        static const unsigned char head[] = { 0x00, 0x01, 0x11, 0x05, 0x02, 0xE6, 0xE3, 0xC4, 0xC5, 0xD9, 0xD9 };   /* CC2 01 / SBA 5,2 "WTDERR" */
        static const unsigned char sba[] = { 0x11, 0x1E, 0x02 };                 /* 行 30 */
        static const unsigned char ra[] = { 0x02, 0x05, 0x02, 0x5C };            /* 5,2 まで（今は 5,8）＝後戻り */
        static const unsigned char soh[] = { 0x01, 0x00 };                       /* 長さ 0 */
        static const unsigned char ea[] = { 0x03, 0x06, 0x02, 0x07, 0, 0, 0, 0, 0, 0 };   /* 長さ 7 */
        static const unsigned char shrt[] = { 0x11, 0x06 };                      /* SBA の桁が無い */
        static const char off[] = { 0x00, 0x02 };
        unsigned char rec[64];
        const unsigned char *tail = sba;
        int tl = sizeof(sba);
        int k;
        if (strcmp(what, "WTDERRRA") == 0) { tail = ra; tl = sizeof(ra); }
        else if (strcmp(what, "WTDERRSOH") == 0) { tail = soh; tl = sizeof(soh); }
        else if (strcmp(what, "WTDERREA") == 0) { tail = ea; tl = sizeof(ea); }
        else if (strcmp(what, "WTDERRSHORT") == 0) { tail = shrt; tl = sizeof(shrt); }
        else if (strcmp(what, "WTDERRSBA") != 0) { if (lg) { fprintf(lg, "unknown WTDERR mode\n"); fclose(lg); } return 1; }   /* 取り違えて SBA を流さない */
        memcpy(rec, head, sizeof(head));
        memcpy(rec + sizeof(head), tail, tl);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, off, 2, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 WTD CC2=02 先に消す)", rc, fdbk);
        sleep(3);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)rec, (Q_Bin4)(sizeof(head) + tl), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 WTD＋誤ったオーダー)", rc, fdbk);
        sleep(8);
        for (k = 0; k < 2; k++) {                                  /* 否定応答の後の出力は CPFA303 で返りうる */
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, off, 2, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 WTD CC2=02 メッセージ待ちを消す)", rc, fdbk);
            if (rc == 0) break;
        }
    } else if (strncmp(what, "EATEST", 6) == 0) {
        /*
         * **EA（0x03）の後の書き始め・属性タイプ・長さ 3 以上を ACS はどう扱うか**（`20260927-ea-acs`）。
         * 1 本の WTD（CC2＝メッセージ待ちを点ける）: 6 行 2 桁に「ABCDEFGHIJ」→ SBA 6,4 → EA〔行き先 6,6〕→「X」→ 6,20 に「END」。
         * EATESTFF＝タイプ 0xFF（長さ 2） / EATEST00＝タイプ 0x00 / EATEST01＝タイプ 0x01 / EATEST3＝長さ 3（0x00・0xFF） /
         * EATESTEND＝行き先が画面の最後の桁（24,80）で、後ろに X が続く / EATESTOVER＝24,79 から XYZ（Z が画面の外）の後ろに X /
         * EATESTWRAP＝24,78 から XYZ（最後の桁でちょうど終わる）→ IC → W の後ろに X。
         * X がどこに書かれるか（6,6 か 6,7 か）・消えた範囲・END が書かれるか（否定応答なら書かれない）・メッセージ待ちを見る。先に消し、8 秒待って消す
         */
        static const unsigned char head[] = { 0x00, 0x01, 0x11, 0x06, 0x02, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xD1, 0x11, 0x06, 0x04 };
        static const unsigned char tailx[] = { 0xE7, 0x11, 0x06, 0x14, 0xC5, 0xD5, 0xC4 };   /* X / SBA 6,20 / END */
        static const char off[] = { 0x00, 0x02 };
        unsigned char rec[64];
        int n = 0, k;
        memcpy(rec, head, sizeof(head)); n = sizeof(head);
        if (strcmp(what, "EATESTWRAP") == 0) {
            /* 最後の桁でちょうど終わる並びの後: SBA 24,78 に XYZ → IC 6,2 → W（W はどこへ行くか——ACS は位置を画面の大きさで割った余りに戻す） */
            static const unsigned char wrap[] = { 0x11, 0x18, 0x4E, 0xE7, 0xE8, 0xE9, 0x13, 0x06, 0x02, 0xE6 };
            memcpy(rec + n, wrap, sizeof(wrap)); n += sizeof(wrap);
        } else if (strcmp(what, "EATESTOVER") == 0) {
            /* 文字が画面の最後の桁を越える: SBA 24,79 に XYZ（Z は画面の外） */
            static const unsigned char over[] = { 0x11, 0x18, 0x4F, 0xE7, 0xE8, 0xE9 };
            memcpy(rec + n, over, sizeof(over)); n += sizeof(over);
        } else if (strcmp(what, "EATESTEND") == 0) {
            /* 行き先が画面の最後の桁: SBA 24,70 に 0123456789 → SBA 24,75 → EA 24,80（0xFF）→ X → 6,20 に END（X はどこへ行くか・否定応答か） */
            static const unsigned char endp[] = { 0x11, 0x18, 0x46, 0xF0, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0x11, 0x18, 0x4B, 0x03, 0x18, 0x50, 0x02, 0xFF };
            memcpy(rec + n, endp, sizeof(endp)); n += sizeof(endp);
        } else {
            rec[n++] = 0x03; rec[n++] = 0x06; rec[n++] = 0x06;
            if (strcmp(what, "EATEST3") == 0) { rec[n++] = 0x03; rec[n++] = 0x00; rec[n++] = 0xFF; }
            else if (strcmp(what, "EATEST00") == 0) { rec[n++] = 0x02; rec[n++] = 0x00; }
            else if (strcmp(what, "EATEST01") == 0) { rec[n++] = 0x02; rec[n++] = 0x01; }
            else if (strcmp(what, "EATESTFF") == 0) { rec[n++] = 0x02; rec[n++] = 0xFF; }
            else { if (lg) { fprintf(lg, "unknown EATEST mode\n"); fclose(lg); } return 1; }
        }
        memcpy(rec + n, tailx, sizeof(tailx)); n += sizeof(tailx);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, off, 2, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 WTD CC2=02 先に消す)", rc, fdbk);
        sleep(3);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)rec, (Q_Bin4)n, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 WTD＋EA)", rc, fdbk);
        sleep(8);
        for (k = 0; k < 2; k++) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, off, 2, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 WTD CC2=02 メッセージ待ちを消す)", rc, fdbk);
            if (rc == 0) break;
        }
    } else if (strcmp(what, "ERRMSGWTD") == 0 || strcmp(what, "ERRMSGRST") == 0) {
        errMsgLineTest(strcmp(what, "ERRMSGRST") == 0);
    } else if (strcmp(what, "READCC2") == 0 || strcmp(what, "CUANOPARM") == 0 || strcmp(what, "SPROLL") == 0) {
        /*
         * **その場で戻る否定応答の残り**（`20260927-early-return-rest`）。先にメッセージ待ちを消してから:
         * READCC2＝5 行に READCC2 を書き、READ MDT（CC2＝0x01 メッセージ待ちを点ける）で止まる（ACS は READ の CC2 を溜めるだけで効かせない——原典の読み）
         * CUANOPARM＝1 本のレコードに WTD（CC2＝0x01）＋ 引数の無い CLEAR UNIT ALTERNATE（最後に置く）。8 秒待つ
         * SPROLL＝1 本のレコードに WTD（5 行に SPROLL）＋ SAVE PARTIAL（引数 5 バイト）＋ 不正な ROLL。8 秒待って WTD、READ MDT
         *   （ACS は SAVE PARTIAL の応答を、戻ったレコードでは送らず次のレコードの終わりで送る——原典の読み。ワイヤで見る）
         */
        static const unsigned char tag1[] = { 0x00, 0x00, 0x11, 0x05, 0x02, 0xD9, 0xC5, 0xC1, 0xC4, 0xC3, 0xC3, 0xF2 };            /* READCC2 */
        static const unsigned char wtd1[] = { 0x00, 0x01, 0x11, 0x05, 0x02, 0xC3, 0xE4, 0xC1 };                                  /* CC2 01 / CUA */
        static const unsigned char wtd2[] = { 0x00, 0x00, 0x11, 0x05, 0x02, 0xE2, 0xD7, 0xD9, 0xD6, 0xD3, 0xD3 };                /* SPROLL */
        static const unsigned char wtd3[] = { 0x00, 0x00, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };                            /* 6 行 NEXT */
        static const char sp[] = { 0x00, 0x00, 0x00, 0x00, 0x00 };
        static const char bad[] = { 0x05, 0x0A, 0x05 };
        static const char off[] = { 0x00, 0x02 };
        Qsn_Cmd_Buf_T cb;
        int k;
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, off, 2, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 WTD CC2=02 先に消す)", rc, fdbk);
        sleep(3);
        if (strcmp(what, "READCC2") == 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, (const char *)tag1, sizeof(tag1), 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 READCC2)", rc, fdbk);
            buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
            if (buf != 0) {
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnReadMDT(0x00, 0x01, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnReadMDT(CC2=01)", rc, fdbk);
                QsnDltBuf(buf, (Q_Fdbk_T *)0);
            }
        } else {
            inzFdbk(fdbk, sizeof(fdbk));
            cb = QsnCrtCmdBuf(256, 0, 0, (Qsn_Cmd_Buf_T *)0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnCrtCmdBuf", (Q_Bin4)cb, fdbk);
            if (cb == 0) { if (lg) { fprintf(lg, "QsnCrtCmdBuf failed\n"); fclose(lg); } return 1; }
            if (strcmp(what, "CUANOPARM") == 0) {
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnPutOutCmd(0x11, (const char *)wtd1, sizeof(wtd1), cb, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnPutOutCmd(0x11 WTD CC2=01 → バッファ)", rc, fdbk);
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnPutOutCmd(0x20, (const char *)0, 0, cb, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnPutOutCmd(0x20 引数なし → バッファ)", rc, fdbk);
            } else {
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnPutOutCmd(0x11, (const char *)wtd2, sizeof(wtd2), cb, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnPutOutCmd(0x11 SPROLL → バッファ)", rc, fdbk);
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnPutOutCmd(0x03, sp, 5, cb, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnPutOutCmd(0x03 SAVE PARTIAL → バッファ)", rc, fdbk);
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnPutOutCmd(0x23, bad, 3, cb, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnPutOutCmd(0x23 不正な ROLL → バッファ)", rc, fdbk);
            }
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutBuf(cb, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutBuf（1 本のレコード）", rc, fdbk);
            QsnDltBuf(cb, (Q_Fdbk_T *)0);
            sleep(8);
            if (strcmp(what, "SPROLL") == 0) {
                for (k = 0; k < 2; k++) {
                    inzFdbk(fdbk, sizeof(fdbk));
                    rc = QsnPutOutCmd(0x11, (const char *)wtd3, sizeof(wtd3), 0, 0, (Q_Fdbk_T *)fdbk);
                    logFdbk("QsnPutOutCmd(0x11 6 行 NEXT)", rc, fdbk);
                    if (rc == 0) break;
                }
                buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
                if (buf != 0) {
                    inzFdbk(fdbk, sizeof(fdbk));
                    rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                    logFdbk("QsnReadMDT", rc, fdbk);
                    QsnDltBuf(buf, (Q_Fdbk_T *)0);
                }
            }
        }
        for (k = 0; k < 2; k++) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, off, 2, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 WTD CC2=02 メッセージ待ちを消す)", rc, fdbk);
            if (rc == 0) break;
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
