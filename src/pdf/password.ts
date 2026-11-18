/**
 * The password as AES-256 PDFs (revision 6) expect it: the standard runs it
 * through SASLprep before hashing, and Acrobat does that to whatever is typed.
 * pdf-lib and pdf.js hash the raw UTF-8, so a copy made from, say, a
 * full-width password typed through an IME, or one with a no-break space,
 * would open here but not in Acrobat. This is the part of SASLprep that
 * changes real typing: non-ASCII spaces become spaces, invisible joiners and
 * variation selectors go, and the rest is NFKC.
 */
export function preparePassword(pw: string): string {
  return pw
    .replace(/[   -​  　]/g, " ")
    .replace(/[­͏᠆᠋-᠍‌‍⁠︀-️﻿]/g, "")
    .normalize("NFKC");
}
