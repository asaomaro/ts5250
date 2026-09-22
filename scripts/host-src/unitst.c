/* Unicode の欄（DDS の CCSID キーワード）を持つ画面を出す試験プログラム（`scripts/build-unitest.mjs`）。
 * UNIDSPF の UNIREC を 1 回出して、実行キーか F キーが戻るまで待つ。**戻った入力の生バイトをログ（IFS）へ残す**——
 * クライアントが Unicode の欄をどの形（EBCDIC か UTF-16BE か）で返したかを見るため。
 * 欄: FA（A・10 桁）／FG1（G・CCSID(13488)・10 字＝20 バイト）／FG2（G・CCSID(1200)・20 バイト）／FGP（G・CCSID 無し・20 バイト）
 * ログの場所は builder が UNITST_LOG に置き換える。ライブラリーは UNITST_LIB。 */
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <recio.h>

#define LOGF UNITST_LOG   /* builder が置き換える */
#define DSPF UNITST_LIB "/UNIDSPF"

static void hex(FILE *lg, const char *label, const unsigned char *p, int n) {
  int i;
  fprintf(lg, "%s:", label);
  for (i = 0; i < n; i++) fprintf(lg, " %02X", p[i]);
  fprintf(lg, "\n");
}

int main(int argc, char **argv) {
  unsigned char buf[70];
  int i;
  FILE *lg = fopen(LOGF, "w");
  _RFILE *fp;
  if (!lg) return 2;
  fp = _Ropen(DSPF, "wr+");
  if (!fp) { fprintf(lg, "_Ropen failed errno=%d\n", errno); fclose(lg); return 3; }
  if (argc > 1 && strcmp(argv[1], "SBA") == 0) {
    /* SBAREC: 1 行 1 桁の入力欄 FX（6 桁）だけ。ホストが SBA(1,0) を出すかを見る */
    memset(buf, 0x40, 7);
    _Rformat(fp, "SBAREC");
    _Rwriterd(fp, buf, 7);
    fprintf(lg, "SBAREC after _Rwriterd: errno=%d\n", errno);
    _Rclose(fp);
    fclose(lg);
    return 0;
  }
  _Rformat(fp, "UNIREC");
  memset(buf, 0x40, 10);                       /* FA: EBCDIC 空白 */
  /* FG1: "AB" + "あい" + UCS-2 空白 */
  for (i = 0; i < 10; i++) { buf[10 + 2 * i] = 0x00; buf[11 + 2 * i] = 0x20; }
  buf[10] = 0x00; buf[11] = 0x41; buf[12] = 0x00; buf[13] = 0x42; buf[14] = 0x30; buf[15] = 0x42; buf[16] = 0x30; buf[17] = 0x44;
  /* FG2: 同じ内容（CCSID 1200） */
  for (i = 0; i < 10; i++) { buf[30 + 2 * i] = 0x00; buf[31 + 2 * i] = 0x20; }
  buf[30] = 0x00; buf[31] = 0x41; buf[32] = 0x00; buf[33] = 0x42; buf[34] = 0x30; buf[35] = 0x42; buf[36] = 0x30; buf[37] = 0x44;
  /* FGP: DBCS 空白（EBCDIC グラフィックの 0x4040） */
  for (i = 0; i < 10; i++) { buf[50 + 2 * i] = 0x40; buf[51 + 2 * i] = 0x40; }
  _Rwriterd(fp, buf, sizeof(buf));
  fprintf(lg, "after _Rwriterd: errno=%d\n", errno);
  hex(lg, "FA ", buf, 10);
  hex(lg, "FG1", buf + 10, 20);
  hex(lg, "FG2", buf + 30, 20);
  hex(lg, "FGP", buf + 50, 20);
  _Rclose(fp);
  fclose(lg);
  return 0;
}
