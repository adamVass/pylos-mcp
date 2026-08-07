/**
 * The invisible-character class, defined once because it has drifted before.
 * Two modules strip these for two different reasons, and a character present
 * in one class but not the other is a live bug in whichever was forgotten:
 *
 *   * html.ts, because render.ts's fence neutralizer matches only ADJACENT
 *     `<` characters. Any invisible character it misses can split `<<<` and
 *     forge a closing marker.
 *   * filename.ts, because a bidi isolate in an on-disk name spoofs the
 *     extension in a file manager: `report[U+2067]fdp.exe` renders as
 *     `reportexe.pdf`.
 *
 * Exported as class SOURCE rather than a compiled RegExp, since a shared /g
 * regex carries `lastIndex` between its callers. Control characters are
 * deliberately absent: the two consumers disagree about them for good reasons,
 * so each composes its own control range around this.
 */
export const INVISIBLE_CLASS =
  '\\u00AD\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u{E0000}-\\u{E007F}'
