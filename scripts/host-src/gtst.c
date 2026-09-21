/* DBCS の 4 種の欄（DDS のデータ型 G・J・E・O）を持つ画面 GREC を出す試験プログラム（`scripts/build-gtest.mjs`。`20260922-g-field-sosi`）。
 * GTDSPF の GREC を 1 回出して、実行キーか F キーが戻るまで待つ。**戻った入力の生バイトをログ（IFS）へ残す**——
 * クライアントが各欄をどの形（SO/SI の有無・埋め字）で返したかを見るため。
 * 欄（いずれも 12 バイト。画面の桁は 12）: FG（G・6 字＝12 バイト。純 DBCS）／FJ（J・12 バイト。SO…SI を含む全角だけ）／FE（E・12 バイト）／FO（O・12 バイト）
 * 初期値: FG=あいう＋全角空白 3・FJ=SO あいう 全角空白 2 SI・FE=`ABC`＋半角空白・FO=`AA あい BB`。
 * ログの場所は builder が GTST_LOG に置き換える。ライブラリーは GTST_LIB。 */
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <recio.h>

#define LOGF GTST_LOG   /* builder が置き換える */
#define DSPF GTST_LIB "/GTDSPF"

static void hex(FILE *lg, const char *label, const unsigned char *p, int n) {
  int i;
  fprintf(lg, "%s:", label);
  for (i = 0; i < n; i++) fprintf(lg, " %02X", p[i]);
  fprintf(lg, "\n");
}

int main(int argc, char **argv) {
  unsigned char buf[48];
  static const unsigned char fg[12] = { 0x44, 0x81, 0x44, 0x82, 0x44, 0x83, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40 };
  static const unsigned char fj[12] = { 0x0E, 0x44, 0x81, 0x44, 0x82, 0x44, 0x83, 0x40, 0x40, 0x40, 0x40, 0x0F };
  static const unsigned char fe[12] = { 0xC1, 0xC2, 0xC3, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40 };
  static const unsigned char fo[12] = { 0xC1, 0xC1, 0x40, 0x0E, 0x44, 0x81, 0x44, 0x82, 0x0F, 0x40, 0xC2, 0xC2 };
  FILE *lg = fopen(LOGF, "w");
  _RFILE *fp;
  if (!lg) return 2;
  fp = _Ropen(DSPF, "wr+");
  if (!fp) { fprintf(lg, "_Ropen failed errno=%d\n", errno); fclose(lg); return 3; }
  _Rformat(fp, "GREC");
  memcpy(buf, fg, 12);
  memcpy(buf + 12, fj, 12);
  memcpy(buf + 24, fe, 12);
  memcpy(buf + 36, fo, 12);
  if (argc > 1 && strcmp(argv[1], "BLANK") == 0) {
    /* 全欄を空（G・J は DBCS 空白、E・O は半角空白）で出す */
    memset(buf + 12, 0x40, 12); buf[12] = 0x0E; buf[23] = 0x0F;
    memset(buf, 0x40, 12);
    memset(buf + 24, 0x40, 24);
  }
  hex(lg, "SENT FG", buf, 12);
  hex(lg, "SENT FJ", buf + 12, 12);
  hex(lg, "SENT FE", buf + 24, 12);
  hex(lg, "SENT FO", buf + 36, 12);
  _Rwriterd(fp, buf, sizeof(buf));
  fprintf(lg, "after _Rwriterd: errno=%d\n", errno);
  hex(lg, "GOT  FG", buf, 12);
  hex(lg, "GOT  FJ", buf + 12, 12);
  hex(lg, "GOT  FE", buf + 24, 12);
  hex(lg, "GOT  FO", buf + 36, 12);
  _Rclose(fp);
  fclose(lg);
  return 0;
}
