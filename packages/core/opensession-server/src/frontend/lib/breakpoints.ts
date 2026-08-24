/**
 * The app's one breakpoint, in the one place both halves of the app read it.
 *
 * The query is authored twice by necessity: `styles/tailwind.css` declares it
 * as the `phone:` / `desktop:` variants for markup, and TypeScript needs it as
 * a string for `matchMedia`. What is not necessary is authoring it twice on the
 * TypeScript side, which is what `useIsPhone` and `useBackSwipe` each did.
 * Moving the boundary in one of them would have left the other answering for
 * the old one, and the failure is quiet: the layout flips at the new width
 * while the behaviour that layout assumes flips at the old one.
 *
 * `breakpoints.test.ts` pins this constant to the stylesheet, so moving the
 * boundary stays one edit plus a failing test that names every other place.
 */

/**
 * A phone-width viewport. The same query as the `phone:` variant in
 * `styles/tailwind.css` and the `@media (max-width: 720px)` blocks in
 * `styles/base.css`, 720 included.
 *
 * Note it is not what `max-[720px]:` compiles to. That is `< 720`, so an
 * element spelled that way drops its phone value one pixel early and disagrees
 * with everything here at exactly 720px wide.
 */
export const PHONE_QUERY = "(max-width: 720px)";

/**
 * The same two queries as StyleX media-query keys, spelled once here so the
 * boundary has exactly one authoring site now that styles are declared in
 * TypeScript: `phone:` / `desktop:` variants used to carry it in
 * `styles/tailwind.css`, and base.css repeats it in its own blocks. StyleX
 * rejects a query string that differs from an earlier declaration of the same
 * key, which is what makes these constants the enforcement mechanism too.
 *
 * 720 included on the phone side, exactly like PHONE_QUERY and base.css.
 */
export const PHONE_MQ = "@media (max-width: 720px)" as const;
export const DESKTOP_MQ = "@media (min-width: 721px)" as const;
