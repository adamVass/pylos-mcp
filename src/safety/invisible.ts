/**
 * Shared by html.ts, where an invisible character between `<` would forge a
 * fence marker, filename.ts, where a bidi isolate spoofs an on-disk
 * extension, and the send confirmation, where it hides data from the reader. Unicode's own property, because a hand list drifts.
 *
 * Class SOURCE, not a RegExp, because a shared /g regex carries `lastIndex`
 * between callers. Needs the `u` flag. Each caller adds its own control range,
 * since the two disagree about control characters.
 */
export const INVISIBLE_CLASS = '\\p{Default_Ignorable_Code_Point}'
