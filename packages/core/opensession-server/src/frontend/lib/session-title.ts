/**
 * Sessions opened by an automation name themselves after the job that opened
 * them: "Simplify · PR #5517 Give floating surfaces a rounder corner". That
 * prefix is bookkeeping rather than subject, and it eats the readable half of
 * a chip, a Home row or a Reviews cell. Strip it wherever a title is shown at
 * a width that has to choose.
 */
export function cleanSessionTitle(title: string): string {
  return (
    title
      .replace(/^(Review|Auto-fix|Mention|Simplify|Fix)\s*·\s*PR\s*#\d+\s*/i, "")
      .trim() || title
  );
}
