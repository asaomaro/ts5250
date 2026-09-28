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
 *     QsnReadMDTAlt             → READ MDT ALT(0x82)
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
    } else if (strcmp(what, "CONTO") == 0) {
        /*
         * **継続欄の O（DBCS open）への挿入の余地・詰め直し**を測る画面（`20260927-cont-o-insert`。ACS `PS5250.processCharWithDBCSOpenContField`）。
         *   (5,10) O の継続欄の先頭 8 桁 `SO あい SI X`＋空白 / (6,10) 中間 8 桁 `YZ` ＋空白 / (7,10) 最終 8 桁（空）。IC は 5,10。READ MDT で待つ
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x86, 0x01, 0x24, 0x00, 0x08,
            0x0E, 0x44, 0x82, 0x44, 0x84, 0x0F, 0xE7, 0x40,
            0x11, 0x06, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x86, 0x03, 0x24, 0x00, 0x08,
            0xE8, 0xE9, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x86, 0x02, 0x24, 0x00, 0x08,
            0x13, 0x05, 0x0A
        };
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 継続の O 欄)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            logInpBuf(buf);
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "CONTOX") == 0) {
        /*
         * **継続欄の O の編集を 1 巡に 1 件ずつ、ホストが受け取ったバイト列で測る画面**（台帳「継続欄の O」。CONTO の画面の読みでは
         * 原典 `PS5250.processCharWithDBCSOpenContField` と食い違ったため、巡ごとに画面を書き直して READ MDT の生バイトで比べる）。
         *   (5,10) 先頭 8 桁 `SO あい SI X`＋埋め / (6,10) 中間 8 桁 `YZ`＋埋め / (7,10) 最終 8 桁（空）。IC は 5,10。
         *   埋めは 1〜8 巡と 11〜12 巡がヌル、9〜10 巡が空白。READ MDT を 12 回（ログは `[C01]`〜`[C12]`）
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x86, 0x01, 0x24, 0x00, 0x08,
            0x0E, 0x44, 0x82, 0x44, 0x84, 0x0F, 0xE7, 0x00,
            0x11, 0x06, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x86, 0x03, 0x24, 0x00, 0x08,
            0xE8, 0xE9, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x86, 0x02, 0x24, 0x00, 0x08,
            0x13, 0x05, 0x0A
        };
        static char tags[12][8];
        unsigned char s2[sizeof(scr)];
        int k, j;
        for (k = 0; k < 12; k++) {
            sprintf(tags[k], "[C%02d] ", k + 1);
            tag = tags[k];
            memcpy(s2, scr, sizeof(scr));
            if (k == 8 || k == 9) {
                /* 埋めを空白に（先頭の区間の 8 桁目と中間の区間の 3〜8 桁目） */
                s2[22] = 0x40;
                for (j = 38; j < 44; j++) s2[j] = 0x40;
            }
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, (const char *)s2, (Q_Bin4)sizeof(s2), 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 継続の O 欄)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
            if (buf != 0) {
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnReadMDT", rc, fdbk);
                logInpBuf(buf);
                QsnDltBuf(buf, (Q_Fdbk_T *)0);
            }
        }
        tag = "";
    } else if (strcmp(what, "WINRESTRICT") == 0 || strcmp(what, "WINUNRESTRICT") == 0 || strcmp(what, "WINUNRESTRICTBAD") == 0) {
        /*
         * **窓のカーソル制限（CREATE WINDOW の flag1 0x80）と、その解除（WDSF 0x52）**を測る画面（台帳「DS5250 の残り」の WDSF 0x52）。
         * ACS `ENPTUI5250.unrestrictWindowCursor` は中身が 2 バイトなら直近の窓の制限を外し、そうでなければ 0x10050110。
         *   (5,10) に深さ 5・幅 20 の制限つきの窓、窓の中の (7,14) に 6 桁の欄。WINUNRESTRICT は続く別のレコードの WTD で `15 00 06 D9 52 00 00`、
         *   WINUNRESTRICTBAD は中身 3 バイトの `15 00 07 D9 52 00 00 00`。READ MDT で待つ
         */
        static const unsigned char win[] = {
            0x00, 0x00,
            0x11, 0x05, 0x0A,
            0x15, 0x00, 0x0E, 0xD9, 0x51, 0x80, 0x00, 0x00, 0x05, 0x14, 0x05, 0x01, 0x80, 0x38, 0x38,
            0x11, 0x07, 0x0D, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06,
            0x13, 0x07, 0x0E
        };
        static const unsigned char un[] = { 0x00, 0x00, 0x15, 0x00, 0x06, 0xD9, 0x52, 0x00, 0x00 };
        static const unsigned char unbad[] = { 0x00, 0x00, 0x15, 0x00, 0x07, 0xD9, 0x52, 0x00, 0x00, 0x00 };
        Qsn_Cmd_Buf_T cb;
        cb = QsnCrtCmdBuf(256, 0, 0, (Qsn_Cmd_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnCrtCmdBuf", (Q_Bin4)cb, fdbk);
        if (cb == 0) { if (lg) { fprintf(lg, "QsnCrtCmdBuf failed\n"); fclose(lg); } return 1; }
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 → バッファ)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)win, (Q_Bin4)sizeof(win), cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 制限つきの窓 → バッファ)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutBuf(cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutBuf", rc, fdbk);
        QsnDltBuf(cb, (Q_Fdbk_T *)0);
        if (strcmp(what, "WINRESTRICT") != 0) {
            /* 窓の後に別のレコードで 0x52（WTD＝CC 2 バイト＋WDSF） */
            inzFdbk(fdbk, sizeof(fdbk));
            if (strcmp(what, "WINUNRESTRICT") == 0) rc = QsnPutOutCmd(0x11, (const char *)un, (Q_Bin4)sizeof(un), 0, 0, (Q_Fdbk_T *)fdbk);
            else rc = QsnPutOutCmd(0x11, (const char *)unbad, (Q_Bin4)sizeof(unbad), 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 WDSF 0x52)", rc, fdbk);
        }
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            logInpBuf(buf);
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "RESEQ") == 0) {
        /*
         * **再順序付け（SOH の本体 3 バイト目＋FCW 0x80nn）で READ MDT の欄の並びが変わるか**を測る画面（台帳「DS5250 の残り」の FCW 0x80xx）。
         * ACS `FFT5250.firstModifiedField` / `nextModifiedField` は SOH の番号の欄から FCW の番号を辿る（0xFF で終わり。辿った先が MDT でなければそこで止まる）。
         *   SOH 先頭=2 / (5,10) #1 FCW 8003 / (7,10) #2 FCW 8001 / (9,10) #3 FCW 80FF。鎖は #2 → #1 → #3。各 6 桁。IC は 5,10。
         *   READ MDT を 2 回（ログは `[R1]` / `[R2]`）
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x01, 0x07, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x80, 0x03, 0x20, 0x00, 0x06,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x80, 0x01, 0x20, 0x00, 0x06,
            0x11, 0x09, 0x09, 0x1D, 0x40, 0x00, 0x80, 0xFF, 0x20, 0x00, 0x06,
            0x13, 0x05, 0x0A
        };
        int k;
        for (k = 0; k < 2; k++) {
            tag = k == 0 ? "[R1] " : "[R2] ";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 再順序付け)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
            if (buf != 0) {
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnReadMDT", rc, fdbk);
                logInpBuf(buf);
                QsnDltBuf(buf, (Q_Fdbk_T *)0);
            }
        }
        tag = "";
    } else if (strcmp(what, "TRANSP") == 0) {
        /*
         * **透過の欄（FCW 0x8400）をどう送るか**を測る画面（台帳「DS5250 の残り」の FCW 0x84xx）。ACS `DS5250.sendAll` は READ MDT 系で
         * `11 行 桁 10 長さ(2) 生バイト`（ヌルも落とさない）、READ INPUT 系でヌルを空白に換えずに送る（原典）。
         *   (5,10) 透過の 8 桁 `AB`＋ヌル / (7,10) 素の 6 桁 `CD`＋ヌル（比べる用）。IC は 5,10。
         *   1 回目は READ MDT、2 回目は同じ画面を書き直して READ INPUT で待つ（ログは `[MDT]` / `[INP]`）
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x84, 0x00, 0x20, 0x00, 0x08, 0xC1, 0xC2,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06, 0xC3, 0xC4,
            0x13, 0x05, 0x0A
        };
        int k;
        for (k = 0; k < 2; k++) {
            tag = k == 0 ? "[MDT] " : "[INP] ";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 透過の欄)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
            if (buf != 0) {
                inzFdbk(fdbk, sizeof(fdbk));
                rc = k == 0 ? QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk)
                            : QsnReadInp(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk(k == 0 ? "QsnReadMDT" : "QsnReadInp", rc, fdbk);
                logInpBuf(buf);
                QsnDltBuf(buf, (Q_Fdbk_T *)0);
            }
        }
        tag = "";
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
    } else if (strcmp(what, "OEDIT") == 0) {
        /*
         * **O（DBCS open）の欄の編集をセルの並びで測る画面**（`20260928-o-field-cells`）。ACS の O 欄は SO・SI・全角・半角のセルを直接書き換える
         * （`PS5250.inputChar` / `insertChar` / `processDeleteChar` / `processBackspace`）ので、打鍵の結果をホストが受け取ったバイト列で比べる。
         *   (3,10)・(5,10)・…・(17,10) に O（FCW 8280）12 桁を 8 つ（FFW 4000）。IC は 3,10。READ MDT を 3 回（ログは `[O1]`〜`[O3]`）
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0C,
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0C,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0C,
            0x11, 0x09, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0C,
            0x11, 0x0B, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0C,
            0x11, 0x0D, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0C,
            0x11, 0x0F, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0C,
            0x11, 0x11, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0C,
            0x13, 0x03, 0x0A
        };
        int k;
        for (k = 0; k < 3; k++) {
            tag = k == 0 ? "[O1] " : k == 1 ? "[O2] " : "[O3] ";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 O の欄)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            buf = QsnCrtInpBuf(2048, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
            if (buf != 0) {
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnReadMDT", rc, fdbk);
                logInpBuf(buf);
                QsnDltBuf(buf, (Q_Fdbk_T *)0);
            }
        }
        tag = "";
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
    } else if (strcmp(what, "SIGNCHK") == 0) {
        /*
         * **符号付き数値の欄の MF と自己点検で、符号の桁を数えるか**を測る画面（`20260928-mandatory-sign-digit`。ACS `Field5250.isFieldFull`・`checkModulusField`）。
         *   (3,10) 符号付き数値（FFW 4707＝シフト 7・MF）6 桁 / (5,10) 符号付き数値の自己点検（FFW 4700・FCW B1A0）6 桁 / (7,10) 素の欄 6 桁。IC は 3,10
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x09, 0x1D, 0x47, 0x07, 0x20, 0x00, 0x06,
            0x11, 0x05, 0x09, 0x1D, 0x47, 0x00, 0xB1, 0xA0, 0x20, 0x00, 0x06,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06,
            0x13, 0x03, 0x0A
        };
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 符号付き数値の MF・自己点検)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            logInpBuf(buf);
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "RESPORDER") == 0 || strcmp(what, "RESPORDER2") == 0) {
        /*
         * **1 本のレコードに応答の要る命令を 2 つ並べたとき、端末が応答をどの順に返すか**（台帳「節目の懸念の残り」の応答の順）。
         * 画面を出してから、コマンド・バッファに RESPORDER は [WSF Query（D9 70）][SAVE SCREEN]、RESPORDER2 は [SAVE SCREEN][WSF Query] を積み、
         * 最後の命令を `QsnPutInpCmd` で送る（バッファの中身と 1 本のレコードになる）。入力は 2 回読む（ログは `[1]` / `[2]`）。ワイヤは relay で採る
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x02, 0xD9, 0xC5, 0xE2, 0xD7,                 /* "RESP" */
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06,
            0x13, 0x05, 0x0A
        };
        static const char query[] = { 0x00, 0x05, (char)0xD9, 0x70, 0x00 };
        Qsn_Cmd_Buf_T cb;
        int k;
        const int saveFirst = strcmp(what, "RESPORDER2") == 0;
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 画面)", rc, fdbk);
        cb = QsnCrtCmdBuf(256, 0, 0, (Qsn_Cmd_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnCrtCmdBuf", (Q_Bin4)cb, fdbk);
        if (cb == 0) { if (lg) { fprintf(lg, "QsnCrtCmdBuf failed\n"); fclose(lg); } return 1; }
        inzFdbk(fdbk, sizeof(fdbk));
        if (saveFirst) rc = QsnPutOutCmd(0x02, (const char *)0, 0, cb, 0, (Q_Fdbk_T *)fdbk);
        else rc = QsnPutOutCmd(0xF3, query, 5, cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk(saveFirst ? "QsnPutOutCmd(0x02 SAVE SCREEN → バッファ)" : "QsnPutOutCmd(0xF3 WSF Query → バッファ)", rc, fdbk);
        buf = QsnCrtInpBuf(8192, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            for (k = 0; k < 2; k++) {
                tag = k == 0 ? "[1] " : "[2] ";
                inzFdbk(fdbk, sizeof(fdbk));
                if (k == 0) {
                    if (saveFirst) rc = QsnPutInpCmd(0xF3, query, 5, &bytesRead, buf, cb, 0, (Q_Fdbk_T *)fdbk);
                    else rc = QsnPutInpCmd(0x02, (const char *)0, 0, &bytesRead, buf, cb, 0, (Q_Fdbk_T *)fdbk);
                    logFdbk(saveFirst ? "QsnPutInpCmd(0xF3 WSF Query＋バッファ)" : "QsnPutInpCmd(0x02 SAVE SCREEN＋バッファ)", rc, fdbk);
                } else {
                    rc = QsnReadInp(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                    logFdbk("QsnReadInp", rc, fdbk);
                }
                if (lg) { fprintf(lg, "%sbytesRead=%d\n", tag, (int)bytesRead); fflush(lg); }
            }
            tag = "";
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
        QsnDltBuf(cb, (Q_Fdbk_T *)0);
    } else if (strcmp(what, "PROGRANGE") == 0) {
        /*
         * **カーソル送り（FCW 0x88nn）の番号が、継続欄の区間を数えない並び（ACS `FFT5250.getStandardFieldList`）の数を超えるとき**の行き先。
         * ACS `nextNonByPassInputFieldPos` は番号を欄の表の数（区間も数える）で検査してから、区間を数えない並びで引く。
         *   (3,10) 欄 #1（FCW 8804）6 桁 / (5,10)・(6,10)・(7,10) 継続欄 3 区間 6 桁ずつ / (9,10) 欄（FCW 8801）6 桁。欄の表は 5・並びは 3。IC は 3,10
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x09, 0x1D, 0x40, 0x00, 0x88, 0x04, 0x20, 0x00, 0x06,
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x86, 0x01, 0x20, 0x00, 0x06,
            0x11, 0x06, 0x09, 0x1D, 0x40, 0x00, 0x86, 0x03, 0x20, 0x00, 0x06,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x86, 0x02, 0x20, 0x00, 0x06,
            0x11, 0x09, 0x09, 0x1D, 0x40, 0x00, 0x88, 0x01, 0x20, 0x00, 0x06,
            0x13, 0x03, 0x0A
        };
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 カーソル送りの番号の範囲)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            logInpBuf(buf);
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "EXITREQ") == 0) {
        /*
         * **右寄せ・符号付き数値の欄に打って欄を出ずに AID を押したとき（ACS のエラー 0x20）**を、カーソルの置き方を変えて巡ごとに測る画面
         * （台帳「AID の前の検査の残り」。ACS `PS5250.processAIDCode` の `isFieldExitReqFlag()`・`fieldExited`）。
         *   (3,10) RZ（FFW 4005）6 桁 / (5,10) 符号付き数値（FFW 4700）6 桁 / (7,10) 素の欄 6 桁。IC は 3,10。READ MDT を 6 回（ログは `[E1]`〜`[E6]`）
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x09, 0x1D, 0x40, 0x05, 0x20, 0x00, 0x06,
            0x11, 0x05, 0x09, 0x1D, 0x47, 0x00, 0x20, 0x00, 0x06,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06,
            0x13, 0x03, 0x0A
        };
        static char etags[6][8];
        int k;
        for (k = 0; k < 6; k++) {
            sprintf(etags[k], "[E%d] ", k + 1);
            tag = etags[k];
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 右寄せ・符号付き数値)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
            if (buf != 0) {
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnReadMDT", rc, fdbk);
                logInpBuf(buf);
                QsnDltBuf(buf, (Q_Fdbk_T *)0);
            }
        }
        tag = "";
    } else if (strcmp(what, "GRIDLIFE") == 0) {
        /*
         * **WDSF 0x60 の罫線の寿命**を測る画面（台帳「DS5250 の残り」の罫線。ACS は罫線を ENPTUI の置き場に持ち、CLEAR UNIT は `GridPlane` だけを捨て、
         * DBCS の画面ならレコードの終わりに置き場を重ね直す——`ENPTUI5250.mergeGridBuffer`。置き場を捨てるのは画面の大きさが変わるとき・0x60 の消去の指定・窓）。
         * 巡ごと（ログは `[G1]`〜`[G7]`）: G1 罫線 / G2 CLEAR UNIT のみ / G3 CLEAR UNIT ALTERNATE（27x132）/ G4 CLEAR UNIT（24x80 へ戻る）＋罫線＋窓 /
         * G5 罫線＋0x5F / G6 罫線、別のレコードで 0x61（5,5 から幅 10・深さ 1 の矩形）/ G7 1 本のレコードに [罫線][CLEAR UNIT][欄]。欄は (20,10) 6 桁
         */
        static const unsigned char fld[] = { 0x11, 0x14, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06, 0x13, 0x14, 0x0A };
        static const unsigned char box[] = {
            0x15, 0x00, 0x16, 0xD9, 0x60, 0x01, 0x20, 0x00, 0x20, 0x00, 0x04, 0x00,
            0x0B, 0x04, 0x00, 0x05, 0x05, 0x28, 0x08, 0xFF, 0xFF, 0xFF, 0xFF
        };
        static const unsigned char win[] = { 0x11, 0x05, 0x0A, 0x15, 0x00, 0x0E, 0xD9, 0x51, 0x00, 0x00, 0x00, 0x05, 0x14, 0x05, 0x01, 0x80, 0x38, 0x38 };
        static const unsigned char remall[] = { 0x15, 0x00, 0x07, 0xD9, 0x5F, 0x00, 0x00, 0x00 };
        static const unsigned char clrgrid[] = { 0x15, 0x00, 0x0B, 0xD9, 0x61, 0x01, 0x00, 0x00, 0x05, 0x05, 0x0A, 0x01 }; /* 5,5 から幅 10・深さ 1 */
        static const unsigned char zero = 0x00;
        static char gtags[7][8];
        unsigned char w[128];
        int k, n;
        Qsn_Cmd_Buf_T cb;
        for (k = 0; k < 7; k++) {
            sprintf(gtags[k], "[G%d] ", k + 1);
            tag = gtags[k];
            cb = QsnCrtCmdBuf(512, 0, 0, (Qsn_Cmd_Buf_T *)0, (Q_Fdbk_T *)fdbk);
            if (cb == 0) break;
            /* WTD のデータ（CC 2 バイト＋オーダー）を巡ごとに組む */
            n = 0; w[n++] = 0x00; w[n++] = 0x00;
            if (k == 0 || k == 3 || k == 4 || k == 5 || k == 6) { memcpy(w + n, box, sizeof(box)); n += sizeof(box); }
            if (k == 3) { memcpy(w + n, win, sizeof(win)); n += sizeof(win); }
            if (k == 4) { memcpy(w + n, remall, sizeof(remall)); n += sizeof(remall); }
            if (k != 6) { memcpy(w + n, fld, sizeof(fld)); n += sizeof(fld); }
            inzFdbk(fdbk, sizeof(fdbk));
            if (k == 2) rc = QsnPutOutCmd(0x20, (const char *)&zero, 1, cb, 0, (Q_Fdbk_T *)fdbk);
            else if (k != 6) rc = QsnPutOutCmd(0x40, (const char *)0, 0, cb, 0, (Q_Fdbk_T *)fdbk);
            logFdbk(k == 2 ? "QsnPutOutCmd(0x20 CLEAR UNIT ALTERNATE)" : "QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, (const char *)w, (Q_Bin4)n, cb, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 WTD)", rc, fdbk);
            if (k == 6) {
                /* 同じレコードで CLEAR UNIT の後に欄だけの WTD（S9R167D の形） */
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnPutOutCmd(0x40, (const char *)0, 0, cb, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT 同じレコード)", rc, fdbk);
                n = 0; w[n++] = 0x00; w[n++] = 0x00; memcpy(w + n, fld, sizeof(fld)); n += sizeof(fld);
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnPutOutCmd(0x11, (const char *)w, (Q_Bin4)n, cb, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnPutOutCmd(0x11 欄)", rc, fdbk);
            }
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutBuf(cb, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutBuf", rc, fdbk);
            QsnDltBuf(cb, (Q_Fdbk_T *)0);
            if (k == 5) {
                /* 別のレコードで 0x61（罫線の置き場を消す） */
                n = 0; w[n++] = 0x00; w[n++] = 0x00; memcpy(w + n, clrgrid, sizeof(clrgrid)); n += sizeof(clrgrid);
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnPutOutCmd(0x11, (const char *)w, (Q_Bin4)n, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnPutOutCmd(0x11 WDSF 0x61)", rc, fdbk);
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
        tag = "";
    } else if (strcmp(what, "WDSFBEH") == 0) {
        /*
         * **WDSF の中身の読み方の差**を画面で測る（台帳「WDSF の中の否定応答」の「応答ではない挙動の差」。ACS `ENPTUI5250` ほか）。巡ごと（ログは `[W1]`〜`[W4]`）:
         *   W1 (5,10) 単一選択の欄に 3 つの選択肢、2 つ目だけ flag3 が 0x40（0x80 が無い——ACS は捨てる）
         *   W2 (5,10) スクロール・バー付き（flag2 0x80）の単一選択のリスト（型 0x21。0x11 は ACS が否定応答）。総数 0x0000012C・位置 0x00000010 の後に選択肢（ACS は 28 バイト目から）
         *   W3 (5,10) カーソルを制限する窓（flag 0x80・深さ 6・幅 30）の中の (7,14) に欄。別のレコードで 0x59 のフラグ 0x40（引き下げの窓だけ——普通の窓は外れない）
         *   W4 W3 と同じで 0x59 のフラグ 0x00（窓が外れ、カーソルが窓の外へ出られる）。W1・W2 の欄は (20,10) 6 桁
         */
        static const unsigned char fld[] = { 0x11, 0x14, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06, 0x13, 0x14, 0x0A };
        static const unsigned char sel3[] = {
            0x11, 0x05, 0x0A, 0x15, 0x00, 0x2C, 0xD9, 0x50, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00,
            0x08, 0x10, 0x00, 0x00, 0x80, 0xC1, 0xC1, 0xC1,
            0x08, 0x10, 0x00, 0x00, 0x40, 0xC2, 0xC2, 0xC2,
            0x08, 0x10, 0x00, 0x00, 0x80, 0xC3, 0xC3, 0xC3
        };
        static const unsigned char selsb[] = {
            0x11, 0x05, 0x0A, 0x15, 0x00, 0x2C, 0xD9, 0x50, 0x00, 0x80, 0x00, 0x21, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x02, 0x02, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x01, 0x2C, 0x00, 0x00, 0x00, 0x10,
            0x08, 0x10, 0x00, 0x00, 0x80, 0xC4, 0xC4, 0xC4,
            0x08, 0x10, 0x00, 0x00, 0x80, 0xC5, 0xC5, 0xC5
        };
        static const unsigned char win[] = { 0x11, 0x05, 0x0A, 0x15, 0x00, 0x09, 0xD9, 0x51, 0x80, 0x00, 0x00, 0x06, 0x1E };
        static const unsigned char fldin[] = { 0x11, 0x07, 0x0D, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06, 0x13, 0x07, 0x0E };
        static const unsigned char selin[] = {
            0x11, 0x07, 0x0E, 0x15, 0x00, 0x1C, 0xD9, 0x50, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
            0x08, 0x10, 0x00, 0x00, 0x80, 0xC6, 0xC6, 0xC6
        };
        static const unsigned char rem40[] = { 0x11, 0x05, 0x0A, 0x15, 0x00, 0x07, 0xD9, 0x59, 0x40, 0x00, 0x00 };
        static const unsigned char rem00[] = { 0x11, 0x05, 0x0A, 0x15, 0x00, 0x07, 0xD9, 0x59, 0x00, 0x00, 0x00 };
        static char wtags[4][8];
        unsigned char w[160];
        int k, n;
        for (k = 0; k < 4; k++) {
            sprintf(wtags[k], "[W%d] ", k + 1);
            tag = wtags[k];
            n = 0; w[n++] = 0x00; w[n++] = 0x00;
            if (k == 0) { memcpy(w + n, sel3, sizeof(sel3)); n += sizeof(sel3); }
            if (k == 1) { memcpy(w + n, selsb, sizeof(selsb)); n += sizeof(selsb); }
            if (k >= 2) { memcpy(w + n, win, sizeof(win)); n += sizeof(win); memcpy(w + n, fldin, sizeof(fldin)); n += sizeof(fldin); }
            else { memcpy(w + n, fld, sizeof(fld)); n += sizeof(fld); }
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, (const char *)w, (Q_Bin4)n, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 WDSF)", rc, fdbk);
            if (k >= 2) {
                n = 0; w[n++] = 0x00; w[n++] = 0x00;
                if (k == 2) { memcpy(w + n, rem40, sizeof(rem40)); n += sizeof(rem40); }
                else { memcpy(w + n, rem00, sizeof(rem00)); n += sizeof(rem00); }
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnPutOutCmd(0x11, (const char *)w, (Q_Bin4)n, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnPutOutCmd(0x11 WDSF 0x59)", rc, fdbk);
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
        tag = "";
    } else if (strcmp(what, "WRITEDATA") == 0) {
        /*
         * **WDSF 0x54（欄へのデータの書き込み。EBCDIC の形・flag 0x80）**を測る画面（台帳「WDSF の中の否定応答」の 0x54。ACS `ENPTUI5250.processWriteData`）。
         * 画面: (5,10) 10 桁の欄（初期値 `OLDVALUE12`）/ (7,10)・(8,10)・(9,10) 4 桁ずつの継続欄 / (20,10) 6 桁の欄。巡ごと（ログは `[D1]`〜`[D4]`）:
         *   D1 (5,10) で `NEW` を書き、同じ WTD で続けて `Z`（書いた後の番地から）/ D2 (5,11)（欄の先頭でない）で書く / D3 (5,10) で 11 桁を書く /
         *   D4 (7,10) の継続欄に `ABCDEFGHIJ`
         */
        static const unsigned char base[] = {
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x0A, 0xD6, 0xD3, 0xC4, 0xE5, 0xC1, 0xD3, 0xE4, 0xC5, 0xF1, 0xF2,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x86, 0x01, 0x20, 0x00, 0x04,
            0x11, 0x08, 0x09, 0x1D, 0x40, 0x00, 0x86, 0x03, 0x20, 0x00, 0x04,
            0x11, 0x09, 0x09, 0x1D, 0x40, 0x00, 0x86, 0x02, 0x20, 0x00, 0x04,
            0x11, 0x14, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06
        };
        static const unsigned char d1[] = { 0x11, 0x05, 0x0A, 0x15, 0x00, 0x09, 0xD9, 0x54, 0x80, 0x00, 0xD5, 0xC5, 0xE6, 0xE9 };
        static const unsigned char d2[] = { 0x11, 0x05, 0x0B, 0x15, 0x00, 0x09, 0xD9, 0x54, 0x80, 0x00, 0xD5, 0xC5, 0xE6 };
        static const unsigned char d3[] = { 0x11, 0x05, 0x0A, 0x15, 0x00, 0x11, 0xD9, 0x54, 0x80, 0x00, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xD1, 0xD2 };
        static const unsigned char d4[] = { 0x11, 0x07, 0x0A, 0x15, 0x00, 0x10, 0xD9, 0x54, 0x80, 0x00, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xD1 };
        static const unsigned char ic[] = { 0x13, 0x14, 0x0A };
        static char dtags[4][8];
        unsigned char w[160];
        int k, n;
        for (k = 0; k < 4; k++) {
            sprintf(dtags[k], "[D%d] ", k + 1);
            tag = dtags[k];
            n = 0; w[n++] = 0x00; w[n++] = 0x00;
            memcpy(w + n, base, sizeof(base)); n += sizeof(base);
            if (k == 0) { memcpy(w + n, d1, sizeof(d1)); n += sizeof(d1); }
            if (k == 1) { memcpy(w + n, d2, sizeof(d2)); n += sizeof(d2); }
            if (k == 2) { memcpy(w + n, d3, sizeof(d3)); n += sizeof(d3); }
            if (k == 3) { memcpy(w + n, d4, sizeof(d4)); n += sizeof(d4); }
            memcpy(w + n, ic, sizeof(ic)); n += sizeof(ic);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, (const char *)w, (Q_Bin4)n, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 WDSF 0x54)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
            if (buf != 0) {
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnReadMDT", rc, fdbk);
                logInpBuf(buf);
                QsnDltBuf(buf, (Q_Fdbk_T *)0);
            }
        }
        tag = "";
    } else if (strcmp(what, "WDSFNEG") == 0) {
        /*
         * **WDSF の構造体ごとの長さ・引数の否定応答**（台帳「WDSF の中の否定応答」。ACS `ENPTUI5250.processWSFOrder` ほか）。巡ごとに (5,10) で 1 つの WDSF を送る
         * （ログは `[N01]`〜`[N15]`）。否定応答ならホストの読みがすぐ CPFA304 で戻る。N15 は正しい 0x5F（対照。Enter を待つ）:
         *   01: N01 0x50 LL=20（選択肢なし）
         *   02: N02 0x51 LL=8
         *   03: N03 0x53 LL=14
         *   04: N04 0x55 LL=8
         *   05: N05 0x58 LL=7
         *   06: N06 0x59 LL=6
         *   07: N07 0x5B LL=7
         *   08: N08 0x5F LL=6
         *   09: N09 0x60 LL=8
         *   10: N10 0x60 区画 0
         *   11: N11 0x60 LL=12
         *   12: N12 0x61 LL=10
         *   13: N13 0x61 区画 0
         *   14: N14 0x61 画面の外
         *   15: N15 0x5F LL=7（正しい——否定応答にならない対照）
         */
        static const unsigned char cs[15][24] = {
            { 0x00,0x14,0xD9,0x50,0x00,0x00,0x00,0x11,0x00,0x00,0x00,0x00,0x00,0x05,0x01,0x01,0x00,0x00,0x00,0x00 },
            { 0x00,0x08,0xD9,0x51,0x00,0x00,0x00,0x05 },
            { 0x00,0x0E,0xD9,0x53,0x00,0x00,0x00,0x00,0x00,0x0A,0x00,0x00,0x00,0x00 },
            { 0x00,0x08,0xD9,0x55,0x00,0x00,0x00,0x00 },
            { 0x00,0x07,0xD9,0x58,0x00,0x00,0x00 },
            { 0x00,0x06,0xD9,0x59,0x00,0x00 },
            { 0x00,0x07,0xD9,0x5B,0x00,0x00,0x00 },
            { 0x00,0x06,0xD9,0x5F,0x00,0x00 },
            { 0x00,0x08,0xD9,0x60,0x01,0x80,0x00,0x00 },
            { 0x00,0x09,0xD9,0x60,0x00,0x80,0x00,0x00,0x00 },
            { 0x00,0x0C,0xD9,0x60,0x01,0x00,0x00,0x00,0x00,0x20,0x00,0x00 },
            { 0x00,0x0A,0xD9,0x61,0x01,0x00,0x00,0x01,0x01,0x50 },
            { 0x00,0x0B,0xD9,0x61,0x00,0x00,0x00,0x01,0x01,0x50,0x18 },
            { 0x00,0x0B,0xD9,0x61,0x01,0x00,0x00,0x01,0x46,0x14,0x01 },
            { 0x00,0x07,0xD9,0x5F,0x00,0x00,0x00 }
        };
        static const int cl[15] = { 20, 8, 14, 8, 7, 6, 7, 6, 8, 9, 12, 10, 11, 11, 7 };
        static const unsigned char pre[] = { 0x11, 0x14, 0x09, 0x1D, 0x40, 0x00, 0x20, 0x00, 0x06, 0x11, 0x05, 0x0A, 0x15 };
        static const unsigned char ic[] = { 0x13, 0x14, 0x0A };
        static char ntags[15][8];
        unsigned char w[80];
        int k, n;
        for (k = 0; k < 15; k++) {
            sprintf(ntags[k], "[N%02d] ", k + 1);
            tag = ntags[k];
            n = 0; w[n++] = 0x00; w[n++] = 0x00;
            memcpy(w + n, pre, sizeof(pre)); n += sizeof(pre);
            memcpy(w + n, cs[k], cl[k]); n += cl[k];
            memcpy(w + n, ic, sizeof(ic)); n += sizeof(ic);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x11, (const char *)w, (Q_Bin4)n, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x11 WDSF)", rc, fdbk);
            inzFdbk(fdbk, sizeof(fdbk));
            buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
            if (buf != 0) {
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnReadMDT", rc, fdbk);
                QsnDltBuf(buf, (Q_Fdbk_T *)0);
            }
        }
        tag = "";
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
         * WTDERRSBA10＝SBA 1,0 の後に入力欄の SF と AB / WTDERRFFWC0＝FFW 0xC000 の SF / WTDERRTDEND＝24,75 から TD 10 バイト / WTDERRCHEND＝24,79 から属性・A・B /
         * WTDERRFLEN0＝長さ 0 の欄 / WTDERRFLDEND＝24,70 から長さ 20 の欄 / WTDERRJODD＝長さ 5 の J 欄 / WTDERRCONTMID＝先頭の無い継続欄の中間（`20260927-wtd-sense-rest`）。
         * WTDERRWEA1＝WEA のタイプ 1 / WTDERRWEA5X＝WEA タイプ 5 の値 0x42 / WTDERRWEA5＝WEA タイプ 5 の値 0x00（SBCS のセッションで流す）/ WTDERRWEAEND＝EA で最後の桁まで消した後の WEA。
         * EARLYROLL と同じく先にメッセージ待ちを消し、8 秒待ってからもう一度消す
         */
        static const unsigned char head[] = { 0x00, 0x01, 0x11, 0x05, 0x02, 0xE6, 0xE3, 0xC4, 0xC5, 0xD9, 0xD9 };   /* CC2 01 / SBA 5,2 "WTDERR" */
        static const unsigned char sba[] = { 0x11, 0x1E, 0x02 };                 /* 行 30 */
        static const unsigned char ra[] = { 0x02, 0x05, 0x02, 0x5C };            /* 5,2 まで（今は 5,8）＝後戻り */
        static const unsigned char soh[] = { 0x01, 0x00 };                       /* 長さ 0 */
        static const unsigned char ea[] = { 0x03, 0x06, 0x02, 0x07, 0, 0, 0, 0, 0, 0 };   /* 長さ 7 */
        static const unsigned char shrt[] = { 0x11, 0x06 };                      /* SBA の桁が無い */
        /* WEA（`20260927-wea-sense`）: 後ろに 6 行 2 桁の「NEXT」を置き、否定応答で WTD が打ち切られるか（NEXT が書かれないか）を見る */
        static const unsigned char wea1[] = { 0x12, 0x01, 0x20, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };   /* タイプ 1 */
        static const unsigned char wea5x[] = { 0x12, 0x05, 0x42, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };  /* タイプ 5・値 0x42 */
        static const unsigned char wea5[] = { 0x12, 0x05, 0x00, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };   /* タイプ 5・値 0x00（SBCS のセッションで流す） */
        static const unsigned char weaend[] = { 0x03, 0x18, 0x50, 0x02, 0x00, 0x12, 0x05, 0x00, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 }; /* EA で最後の桁まで消した後 */
        /* WTD の中の受理の残り（`20260927-wtd-sense-rest`）: どれも後ろに 6 行 2 桁の「NEXT」を置く */
        static const unsigned char sba10[] = { 0x11, 0x01, 0x00, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x05, 0xC1, 0xC2, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };   /* SBA 1,0 → 入力欄の SF → AB */
        static const unsigned char ffwc0[] = { 0x11, 0x07, 0x09, 0x1D, 0xC0, 0x00, 0x24, 0x00, 0x05, 0xC1, 0xC2, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };  /* FFW 0xC000 */
        static const unsigned char tdend[] = { 0x11, 0x18, 0x4B, 0x10, 0x00, 0x0A, 0xF0, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };  /* 24,75 から TD 10 バイト（4 バイトが画面の外） */
        static const unsigned char chend[] = { 0x11, 0x18, 0x4F, 0x22, 0xC1, 0xC2, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };  /* 24,79 から 属性 0x22・A・B（B が画面の外） */
        /* 欄の追加の失敗（ACS `FFT5250.addFieldToFFT` が null → 0x10050125）: 長さ 0 / 画面の末尾を越える / J の奇数長 / 先頭の無い継続欄の中間 */
        static const unsigned char flen0[] = { 0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x00, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };
        static const unsigned char fldend[] = { 0x11, 0x18, 0x45, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x14, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };   /* 24,70 から長さ 20 */
        static const unsigned char jodd[] = { 0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x00, 0x24, 0x00, 0x05, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };
        static const unsigned char contmid[] = { 0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x86, 0x03, 0x24, 0x00, 0x05, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };
        /* WDSF の頭の検査（`20260927-wdsf-sense`。ACS `ENPTUI5250.processWSFOrder`）: LL が 3 / クラス 0xD8 / 知らない型 0x7F / ACS が受ける型 0x55（否定応答なし） */
        static const unsigned char wdsfll[] = { 0x15, 0x00, 0x03, 0xD9, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };
        static const unsigned char wdsfcls[] = { 0x15, 0x00, 0x06, 0xD8, 0x50, 0x00, 0x00, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };
        static const unsigned char wdsftype[] = { 0x15, 0x00, 0x04, 0xD9, 0x7F, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };
        static const unsigned char wdsf55[] = { 0x15, 0x00, 0x04, 0xD9, 0x55, 0x11, 0x06, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };
        static const char off[] = { 0x00, 0x02 };
        unsigned char rec[64];
        const unsigned char *tail = sba;
        int tl = sizeof(sba);
        int k;
        if (strcmp(what, "WTDERRRA") == 0) { tail = ra; tl = sizeof(ra); }
        else if (strcmp(what, "WTDERRSOH") == 0) { tail = soh; tl = sizeof(soh); }
        else if (strcmp(what, "WTDERREA") == 0) { tail = ea; tl = sizeof(ea); }
        else if (strcmp(what, "WTDERRSHORT") == 0) { tail = shrt; tl = sizeof(shrt); }
        else if (strcmp(what, "WTDERRWEA1") == 0) { tail = wea1; tl = sizeof(wea1); }
        else if (strcmp(what, "WTDERRWEA5X") == 0) { tail = wea5x; tl = sizeof(wea5x); }
        else if (strcmp(what, "WTDERRWEA5") == 0) { tail = wea5; tl = sizeof(wea5); }
        else if (strcmp(what, "WTDERRWEAEND") == 0) { tail = weaend; tl = sizeof(weaend); }
        else if (strcmp(what, "WTDERRSBA10") == 0) { tail = sba10; tl = sizeof(sba10); }
        else if (strcmp(what, "WTDERRFFWC0") == 0) { tail = ffwc0; tl = sizeof(ffwc0); }
        else if (strcmp(what, "WTDERRTDEND") == 0) { tail = tdend; tl = sizeof(tdend); }
        else if (strcmp(what, "WTDERRCHEND") == 0) { tail = chend; tl = sizeof(chend); }
        else if (strcmp(what, "WTDERRFLEN0") == 0) { tail = flen0; tl = sizeof(flen0); }
        else if (strcmp(what, "WTDERRFLDEND") == 0) { tail = fldend; tl = sizeof(fldend); }
        else if (strcmp(what, "WTDERRJODD") == 0) { tail = jodd; tl = sizeof(jodd); }
        else if (strcmp(what, "WTDERRCONTMID") == 0) { tail = contmid; tl = sizeof(contmid); }
        else if (strcmp(what, "WTDERRWDSFLL") == 0) { tail = wdsfll; tl = sizeof(wdsfll); }
        else if (strcmp(what, "WTDERRWDSFCLS") == 0) { tail = wdsfcls; tl = sizeof(wdsfcls); }
        else if (strcmp(what, "WTDERRWDSFTYPE") == 0) { tail = wdsftype; tl = sizeof(wdsftype); }
        else if (strcmp(what, "WTDERRWDSF55") == 0) { tail = wdsf55; tl = sizeof(wdsf55); }
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
    } else if (strcmp(what, "READALT") == 0 || strcmp(what, "READDBCS") == 0 ) {
        /*
         * **ALT の読み取り（0x83・0x82）と 0x52 で、欄データの加工がどう違うか**（`20260927-read-alt-raw`）。
         * MDT を立てた 4 欄を描いてから 0x83 → 0x82（Enter 待ち）→ 0x52（Enter 待ち）の順に読み、ホストが受け取ったバイト列を残す:
         *   (5,10) 長さ10 "AB C" ＋ 実空白 6 / (7,10) 長さ10 "A" NUL "B" ＋ NUL 7 /
         *   (9,10) 長さ6 符号付き "  012-" / (11,10) 長さ6 符号付き "   12 " /
         *   (13,10) 長さ6 符号付き "    A-" / (15,10) 長さ6 符号付き "     -"（符号の手前が数字でないとき。ACS の原典は手前を見ずにゾーンを 0xD にする）
         * 加工の違い（符号・NUL・末尾の実空白）をどれか 1 つの欄が必ず踏むように選んだ。
         */
        static const unsigned char wtd[] = {
            0x00, 0x00,
            0x11, 0x03, 0x02, 0xD9, 0xC5, 0xC1, 0xC4, 0xC1, 0xD3, 0xE3,         /* "READALT" */
            0x11, 0x05, 0x09, 0x1D, 0x48, 0x00, 0x24, 0x00, 0x0A,
            0xC1, 0xC2, 0x40, 0xC3, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
            0x11, 0x07, 0x09, 0x1D, 0x48, 0x00, 0x24, 0x00, 0x0A,
            0xC1, 0x00, 0xC2, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x11, 0x09, 0x09, 0x1D, 0x4F, 0x00, 0x24, 0x00, 0x06,
            0x40, 0x40, 0xF0, 0xF1, 0xF2, 0x60,
            0x11, 0x0B, 0x09, 0x1D, 0x4F, 0x00, 0x24, 0x00, 0x06,
            0x40, 0x40, 0x40, 0xF1, 0xF2, 0x40,
            0x11, 0x0D, 0x09, 0x1D, 0x4F, 0x00, 0x24, 0x00, 0x06,
            0x40, 0x40, 0x40, 0x40, 0xC1, 0x60,
            0x11, 0x0F, 0x09, 0x1D, 0x4F, 0x00, 0x24, 0x00, 0x06,
            0x40, 0x40, 0x40, 0x40, 0x40, 0x60,
            0x13, 0x05, 0x0A
        };
        /*
         * READDBCS: **DBCS の欄**の欄データ（`20260927-read-dbcs-fields`）。MDT を立てた 7 欄（ホストが書いた値のまま・打鍵しない）:
         *   (5,10) O 12 桁 SO あ SI ＋ 実空白 8 / (7,10) O 12 桁 SO あ SI ＋ NUL 8 / (9,10) O 12 桁 SO あ SI NUL A ＋ NUL 6 /
         *   (11,10) G 8 桁 あ ＋ 0x40 6 / (13,10) G 8 桁 あ ＋ NUL 6 / (15,10) J 12 桁 SO あ ＋ 0x4040 4 組 SI / (17,10) E 12 桁 SO あ SI ＋ NUL 8 /
         *   (19,10) G 8 桁 NUL だけ / (21,10) O 12 桁 NUL だけ
         * ACS `sendAll` は DBCS の欄も末尾の NUL だけを落とす（実空白は送る）。直す前の当 PJ は未編集の DBCS 欄の末尾の空白を落とし、G は 0x40 で埋めていた
         */
        static const unsigned char wtdDbcs[] = {
            0x00, 0x00,
            0x11, 0x03, 0x02, 0xD9, 0xC5, 0xC1, 0xC4, 0xC4, 0xC2, 0xC3, 0xE2,         /* "READDBCS" */
            0x11, 0x05, 0x09, 0x1D, 0x48, 0x00, 0x82, 0x80, 0x24, 0x00, 0x0C,
            0x0E, 0x44, 0x82, 0x0F, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
            0x11, 0x07, 0x09, 0x1D, 0x48, 0x00, 0x82, 0x80, 0x24, 0x00, 0x0C,
            0x0E, 0x44, 0x82, 0x0F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x11, 0x09, 0x09, 0x1D, 0x48, 0x00, 0x82, 0x80, 0x24, 0x00, 0x0C,
            0x0E, 0x44, 0x82, 0x0F, 0x00, 0xC1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x11, 0x0B, 0x09, 0x1D, 0x48, 0x00, 0x82, 0x20, 0x24, 0x00, 0x08,
            0x44, 0x82, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
            0x11, 0x0D, 0x09, 0x1D, 0x48, 0x00, 0x82, 0x20, 0x24, 0x00, 0x08,
            0x44, 0x82, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x11, 0x0F, 0x09, 0x1D, 0x48, 0x00, 0x82, 0x00, 0x24, 0x00, 0x0C,
            0x0E, 0x44, 0x82, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x0F,
            0x11, 0x11, 0x09, 0x1D, 0x48, 0x00, 0x82, 0x40, 0x24, 0x00, 0x0C,
            0x0E, 0x44, 0x82, 0x0F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x11, 0x13, 0x09, 0x1D, 0x48, 0x00, 0x82, 0x20, 0x24, 0x00, 0x08,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x11, 0x15, 0x09, 0x1D, 0x48, 0x00, 0x82, 0x80, 0x24, 0x00, 0x0C,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x13, 0x05, 0x0A
        };
        const int dbcsMode = strcmp(what, "READDBCS") == 0;
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = dbcsMode
            ? QsnPutOutCmd(0x11, (const char *)wtdDbcs, (Q_Bin4)sizeof(wtdDbcs), 0, 0, (Q_Fdbk_T *)fdbk)
            : QsnPutOutCmd(0x11, (const char *)wtd, (Q_Bin4)sizeof(wtd), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 試験画面)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(4096, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnCrtInpBuf", (Q_Bin4)buf, fdbk);
        if (buf != 0) {
            tag = "[0x83] ";
            bytesRead = 0;
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDTImmAlt(&bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDTImmAlt", rc, fdbk);
            logInpBuf(buf);

            tag = "[0x82] ";
            inzFdbk(fdbk, sizeof(fdbk));
            QsnClrBuf((Q_Handle_T)buf, (Q_Fdbk_T *)fdbk);
            bytesRead = 0;
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDTAlt(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDTAlt", rc, fdbk);
            logInpBuf(buf);

            tag = "[0x52] ";
            inzFdbk(fdbk, sizeof(fdbk));
            QsnClrBuf((Q_Handle_T)buf, (Q_Fdbk_T *)fdbk);
            bytesRead = 0;
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            logInpBuf(buf);
            tag = "";
            QsnDltBuf((Q_Handle_T)buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "WECONLY") == 0 || strcmp(what, "WECTWICE") == 0 || strcmp(what, "WECONLYW") == 0) {
        /*
         * **READ の無い WRITE ERROR CODE だけのレコード**（`20260927-wec-only-unlock`）。ACS `processWriteErrorCode` → `initKeyboard` はエラー状態なら施錠を解く。
         * 画面（5,10 に 10 桁の入力欄・IC）→ 0x21「WECONLY ERR」だけを撃つ → 10 秒待つ（この間に端末で Reset と打鍵と Enter を試す）→ READ MDT で受けた AID と欄を残す
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x02, 0xE6, 0xC5, 0xC3, 0xD6, 0xD5, 0xD3, 0xE8,                /* "WECONLY" */
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x0A,
            0x13, 0x05, 0x0A
        };
        static const unsigned char err[] = { 0x22, 0xE6, 0xC5, 0xC3, 0xD6, 0xD5, 0xD3, 0xE8, 0x40, 0xC5, 0xD9, 0xD9 };  /* 属性 22 "WECONLY ERR" */
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 画面)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x21, (const char *)err, (Q_Bin4)sizeof(err), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x21 だけ)", rc, fdbk);
        sleep(10);
        if (strcmp(what, "WECTWICE") == 0) {
            /* WECTWICE: もう一度 0x21 だけを撃ってから 10 秒待つ——先に溜まった AID を 2 回目の 0x21 が捨てるか（ACS `initKeyboard` の `pending_aid = 0`） */
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x21, (const char *)err, (Q_Bin4)sizeof(err), 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x21 2 回目)", rc, fdbk);
            sleep(10);
        }
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            /* WECONLYW: READ の前に同じレコードで 11,2 へ "NEXT" を書く WTD を置く——溜めた AID が送るカーソルが、書いた位置か押したときの位置かを見る */
            static const unsigned char wn[] = { 0x00, 0x00, 0x11, 0x0B, 0x02, 0xD5, 0xC5, 0xE7, 0xE3 };
            Qsn_Cmd_Buf_T rcb = 0;
            if (strcmp(what, "WECONLYW") == 0) {
                inzFdbk(fdbk, sizeof(fdbk));
                rcb = QsnCrtCmdBuf(128, 0, 0, (Qsn_Cmd_Buf_T *)0, (Q_Fdbk_T *)fdbk);
                inzFdbk(fdbk, sizeof(fdbk));
                rc = QsnPutOutCmd(0x11, (const char *)wn, (Q_Bin4)sizeof(wn), rcb, 0, (Q_Fdbk_T *)fdbk);
                logFdbk("QsnPutOutCmd(0x11 NEXT → バッファ)", rc, fdbk);
            }
            tag = "[READ] ";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, rcb, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            logInpBuf(buf);
            tag = "";
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "CACUA") == 0 || strcmp(what, "CACFT") == 0 || strcmp(what, "CANONE") == 0) {
        /*
         * **SOH の CA キーの申告（欄データを送らない F キー）を CLEAR UNIT ALTERNATE・CLEAR FORMAT TABLE が捨てるか**（`20260927-clear-ca-mask`）。
         * ACS は CU・CUA・CFT のどれも `processClearFMT` → `clearSOHPFKeyTable`。当 PJ は CU だけ捨てる。
         *   WTD（SOH: F3 を CA・3,2 に "SOH"・5,10 に入力欄）→ CACUA＝0x20（引数 0x00）/ CACFT＝0x50 / CANONE＝何もしない →
         *   WTD（3,2 に "AFTER"・7,10 に入力欄・IC 7,10。SOH なし）→ READ MDT。端末で AB を打って F3 を押し、READ が欄を受けたかを見る
         */
        static const unsigned char w1[] = {
            0x00, 0x00,
            0x01, 0x07, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x04,             /* SOH: F3 を CA */
            0x11, 0x03, 0x02, 0xE2, 0xD6, 0xC8,                                /* "SOH" */
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x0A
        };
        static const unsigned char w2[] = {
            0x00, 0x00,
            0x11, 0x03, 0x02, 0xC1, 0xC6, 0xE3, 0xC5, 0xD9,                    /* "AFTER" */
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x0A,
            0x13, 0x07, 0x0A
        };
        static const char cua[] = { 0x00 };
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)w1, (Q_Bin4)sizeof(w1), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 SOH)", rc, fdbk);
        if (strcmp(what, "CACUA") == 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x20, cua, 1, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x20 CUA)", rc, fdbk);
        } else if (strcmp(what, "CACFT") == 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnPutOutCmd(0x50, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnPutOutCmd(0x50 CFT)", rc, fdbk);
        }
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)w2, (Q_Bin4)sizeof(w2), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 AFTER)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            tag = "[READ] ";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            logInpBuf(buf);
            tag = "";
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "UNLOCKWTD") == 0 || strcmp(what, "UNLOCKWTDNOIC") == 0 || strcmp(what, "UNLOCKWTDCC1") == 0) {
        /*
         * **解錠中に届いた WTD でカーソルが動くか**（`20260927-unlocked-wtd-cursor`。ACS `preprocessWCC2` の頭の条件）。
         *   1 本目（出力だけ）: CLEAR UNIT → WTD（CC2 0x08 で解錠・5,10 と 7,10 と 9,2 に入力欄・IC 5,10）
         *   6 秒待つ（この間に端末でカーソルを 9,2 へ動かす）
         *   2 本目（1 本のレコード）: WTD（CC1 00・CC2 08。UNLOCKWTD は IC 7,10 / UNLOCKWTDNOIC は IC なし / UNLOCKWTDCC1 は CC1 0x20〔MDT を戻す〕と IC 7,10）＋ READ MDT
         * READ で送られたカーソルの位置（端末で Enter を押す）と画面のカーソルを見る
         */
        static const unsigned char w1[] = {
            0x00, 0x08,
            0x11, 0x03, 0x02, 0xE4, 0xD5, 0xD3, 0xD6, 0xC3, 0xD2,             /* "UNLOCK" */
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x0A,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x0A,
            0x11, 0x09, 0x01, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x0A,
            0x13, 0x05, 0x0A
        };
        unsigned char w2[16];
        int wl = 0;
        Qsn_Cmd_Buf_T cb;
        w2[wl++] = strcmp(what, "UNLOCKWTDCC1") == 0 ? 0x20 : 0x00;
        w2[wl++] = 0x08;
        w2[wl++] = 0x11; w2[wl++] = 0x0B; w2[wl++] = 0x02; w2[wl++] = 0xD5; w2[wl++] = 0xC5; w2[wl++] = 0xE7; w2[wl++] = 0xE3;  /* 11,2 "NEXT" */
        if (strcmp(what, "UNLOCKWTDNOIC") != 0) { w2[wl++] = 0x13; w2[wl++] = 0x07; w2[wl++] = 0x0A; }
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)w1, (Q_Bin4)sizeof(w1), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 1 本目)", rc, fdbk);
        sleep(6);
        inzFdbk(fdbk, sizeof(fdbk));
        cb = QsnCrtCmdBuf(256, 0, 0, (Qsn_Cmd_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)w2, (Q_Bin4)wl, cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 2 本目 → バッファ)", rc, fdbk);
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            tag = "[READ] ";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, cb, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT（WTD と 1 本のレコード）", rc, fdbk);
            logInpBuf(buf);
            tag = "";
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
        QsnDltBuf(cb, (Q_Fdbk_T *)0);
    } else if (strcmp(what, "JHOME") == 0) {
        /*
         * **ホーム位置が J（DBCS 専用）欄のときの Home**（`20260927-key-edit-rest`。ACS `PS5250.processHome`: ホーム位置〔欄の先頭＝SO の桁〕に居なければそこへ移り、
         * SO の桁なら 1 つ進める。居れば Record Backspace）。J 欄（5,10・12 桁・IC 5,10）と SBCS 欄（7,10）→ READ MDT。受けた AID で Record Backspace（F8）が出たかを見る
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x02, 0xD1, 0xC8, 0xD6, 0xD4, 0xC5,                       /* "JHOME" */
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x82, 0x00, 0x24, 0x00, 0x0C,
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x06,
            0x13, 0x05, 0x0A
        };
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 J 欄)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            tag = "[READ] ";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            logInpBuf(buf);
            tag = "";
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "CSRINP") == 0 || strcmp(what, "CSRFREE") == 0) {
        /*
         * **SOH のフラグ 0x10（DDS の CSRINPONLY。カーソルを入力欄だけに動かす）**（`20260927-key-edit-rest`。ACS `FFT5250.moveCursorToInput`）。
         * CSRINP＝SOH（フラグ 0x10）/ CSRFREE＝SOH（フラグ 0。対照）。入力欄 5,10・5,40・9,20（6 桁）・IC 5,10 → READ MDT
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x01, 0x07, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x11, 0x03, 0x02, 0xC3, 0xE2, 0xD9, 0xC9, 0xD5, 0xD7,                       /* "CSRINP"（CSRFREE も同じ見出し。フラグのバイトだけ違う） */
            0x11, 0x05, 0x09, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x06,
            0x11, 0x05, 0x27, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x06,
            0x11, 0x09, 0x13, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x06,
            0x13, 0x05, 0x0A
        };
        unsigned char w[sizeof(scr)];
        memcpy(w, scr, sizeof(scr));
        if (strcmp(what, "CSRFREE") == 0) w[4] = 0x00;
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)w, (Q_Bin4)sizeof(w), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 CSRINP)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            tag = "[READ] ";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            logInpBuf(buf);
            tag = "";
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "LATEWTD") == 0) {
        /*
         * **SysReq の行を出している間に届いた WTD を止めるか**（`20260927-sysreq-line-hold`。ACS `DS5250.checkContention` は `getMsgLinePos() != -1` の間待つ——
         * WEC のエラーと SysReq の行が同じ仕組み）。画面（5,10 に入力欄）→ 8 秒待つ（この間に端末で SysReq の行を出す）→ WTD（5,2 に "LATE"・CC2 0x08）→ READ MDT
         */
        static const unsigned char scr[] = {
            0x00, 0x00,
            0x11, 0x03, 0x02, 0xD3, 0xC1, 0xE3, 0xC5, 0xE6, 0xE3, 0xC4,               /* "LATEWTD" */
            0x11, 0x07, 0x09, 0x1D, 0x40, 0x00, 0x24, 0x00, 0x06,
            0x13, 0x07, 0x0A
        };
        static const unsigned char late[] = { 0x00, 0x08, 0x11, 0x05, 0x02, 0xD3, 0xC1, 0xE3, 0xC5 };  /* 5,2 "LATE" */
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)scr, (Q_Bin4)sizeof(scr), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 画面)", rc, fdbk);
        sleep(8);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)late, (Q_Bin4)sizeof(late), 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 LATE)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            tag = "[READ] ";
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
            logInpBuf(buf);
            tag = "";
            QsnDltBuf(buf, (Q_Fdbk_T *)0);
        }
    } else if (strcmp(what, "HOLDCC2") == 0) {
        /*
         * **保留が始まったレコードの、それより前の WTD の CC2 はいつ効くか**（`20260927-sysreq-line-hold`。ACS は `processWCC2` をレコードの終わりで呼ぶので、
         * `checkContention` で止まった間は効かない——原典の読み）。メッセージ待ちを消してから 1 本のレコード: WTD（CC2 0x01＝点ける・3,2 に HOLDCC2）＋ 0x21 ＋ WTD（5,2 に HELD）。
         * 12 秒待って（この間に端末で Reset）READ MDT。メッセージ待ちがいつ点くかを見る
         */
        static const unsigned char off[] = { 0x00, 0x02 };
        static const unsigned char w1[] = { 0x00, 0x01, 0x11, 0x03, 0x02, 0xC8, 0xD6, 0xD3, 0xC4, 0xC3, 0xC3, 0xF2 };
        static const unsigned char err[] = { 0x22, 0xC8, 0xD6, 0xD3, 0xC4, 0x40, 0xC5, 0xD9, 0xD9 };
        static const unsigned char w2[] = { 0x00, 0x00, 0x11, 0x05, 0x02, 0xC8, 0xC5, 0xD3, 0xC4 };
        Qsn_Cmd_Buf_T cb;
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x40, (const char *)0, 0, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x40 CLEAR UNIT)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, off, 2, 0, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 WTD CC2=02 先に消す)", rc, fdbk);
        sleep(3);
        inzFdbk(fdbk, sizeof(fdbk));
        cb = QsnCrtCmdBuf(256, 0, 0, (Qsn_Cmd_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)w1, (Q_Bin4)sizeof(w1), cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 CC2=01 → バッファ)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x21, (const char *)err, (Q_Bin4)sizeof(err), cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x21 → バッファ)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutOutCmd(0x11, (const char *)w2, (Q_Bin4)sizeof(w2), cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutOutCmd(0x11 HELD → バッファ)", rc, fdbk);
        inzFdbk(fdbk, sizeof(fdbk));
        rc = QsnPutBuf(cb, 0, (Q_Fdbk_T *)fdbk);
        logFdbk("QsnPutBuf（1 本のレコード）", rc, fdbk);
        QsnDltBuf(cb, (Q_Fdbk_T *)0);
        sleep(12);
        inzFdbk(fdbk, sizeof(fdbk));
        buf = QsnCrtInpBuf(1024, 0, 0, (Qsn_Inp_Buf_T *)0, (Q_Fdbk_T *)fdbk);
        if (buf != 0) {
            inzFdbk(fdbk, sizeof(fdbk));
            rc = QsnReadMDT(0x00, 0x00, &bytesRead, buf, 0, 0, (Q_Fdbk_T *)fdbk);
            logFdbk("QsnReadMDT", rc, fdbk);
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
