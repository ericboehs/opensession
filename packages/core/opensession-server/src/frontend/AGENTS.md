# Working on the Open Session web UI

The root `AGENTS.md` still applies. This file defines the consistency rules for
everything under `packages/core/opensession-server/src/frontend/`. Preserve the established Open Session visual
language instead of introducing a new local style for each feature.

## Copy and naming

- Use sentence case for headings, buttons, menu items, tabs, field labels, and
  empty states. Do not use title case or decorative ALL CAPS. Proper nouns and
  established acronyms keep their normal capitalization.
- Keep copy short, direct, and specific. Buttons describe the action (`Create
  session`, `Try again`); headings name the place or object (`Model providers`).
- Reuse the product's existing terms. Do not casually rename projects, sessions,
  workspaces, automations, runs, reviews, or other established concepts.
- Prefer plain language over implementation details. Errors should say what
  happened and, when useful, what the person can do next.
- Use an ellipsis only when an action requires more input before it happens,
  not as decoration or to make labels feel softer.

## Components

- Search `packages/core/opensession-server/src/frontend/ui/` before building a control. New buttons, menus,
  modals, sheets, popovers, tooltips, switches, page headers, settings rows,
  loading states, empty states, and alerts should use the existing primitive.
- Use `Button` for actions and glyphs from `components/icons.tsx` for interface
  icons. Icon-only controls need an accessible name and usually a tooltip.
- Icons are iconic-pro, drawn on a 24-unit grid and stroked through the shared
  `stroke` object in `components/icons.tsx` (1.5, round caps and joins). Spread
  it rather than writing a `strokeWidth`, so every glyph carries one weight. A
  new icon is a new export in that file, traced to the same grid; do not inline
  an SVG at a call site or pull one from another set.
- This is the web's convention, not the product's. The native app draws SF
  Symbols for the same reasons in reverse (see `packages/clients/ios/AGENTS.md`), so a glyph
  that exists in both clients is expected to look different in each. Do not
  port one set across to make them match.
- Build new interactive primitives on Base UI and wrap them in `ui/`. Keep the
  composable Base UI parts API; do not replace it with a large prop-driven
  component or bypass its focus and keyboard behavior.
- Put reusable visual vocabulary in `ui/`; keep feature-specific composition in
  `components/`. Extract a primitive only when more than one surface should
  intentionally look and behave the same.
- Do not create one-off versions of an existing card, spinner, empty state,
  alert, button, or popup. Extend the shared primitive with a small, general
  variant when the difference is genuinely reusable.

## Styling

- Use Tailwind utilities for new and touched UI. `styles/legacy.css` is empty
  and stays that way; component styling lives in a `lib/*-classes.ts` string
  beside its component, or in a primitive in `ui/`. A class name left on the
  markup is a hook for something else (base.css, a `closest()` call, another
  module's `[.that-class_&]`) — say which, in a comment, or drop the name.
- Use the semantic tokens from `styles/tailwind.css`, such as `bg-panel`,
  `text-fg`, `text-dim`, and `border-line`. Never add raw color values or stock
  Tailwind palette colors to product UI.
- Do not frame a section, card, or tile in a border. A block that sits on its
  own fill (`bg-panel` on `bg-surface`) is already separated from the page, and
  a hairline around it adds a second edge that makes a page of them read as a
  form. Separate by surface, spacing, and radius instead. Borders stay for the
  things that are genuinely a line: a divider between rows, the edge of an
  input or a control, a table rule. The one carve-out is a surface whose fill
  has deliberately been taken below where a fill alone holds its shape, which
  today is the settings plate (`--settings-plate`, `ui/settings.tsx`): there
  the hairline replaces the weight the fill gave up rather than adding to it,
  and the pair is quieter than the full L1 grey was on its own. It takes
  `border-divider`, the chrome seam, not the `border-line` its own rows take:
  closing a block's shape asks less of a line than separating two rows does,
  and at the row weight the outline was the loudest thing on the page. That is
  a trade, not a licence. It does not extend to `Card`, which stays
  borderless, and a card that still carries a normal fill has nothing to
  trade.
- Round generously, and scale the radius with the box. The scale in
  `styles/tailwind.css` runs `rounded-sm` 4, `rounded-md` 7, `rounded-lg` 14,
  `rounded-xl` 18, `rounded-2xl` 22, plus the named chrome corners
  `rounded-control` / `rounded-row` (12) and `rounded-popup` (16) — each of them
  authored as `calc(<n>px * var(--rf))`, so a browser with `corner-shape`
  support renders them 1.35x larger. A small
  control keeps a small corner; a card takes `rounded-xl`, and a container that
  holds cards takes `rounded-2xl`. Never write an arbitrary radius, and never
  give one surface two different corners.
- Keep nested corners concentric: an inner radius plus the padding around it
  should equal the outer radius. A child rounded as hard as its parent pinches
  the gap between them, and a square child inside a round parent reads as a
  mistake at the corner.
- Corners are squircles. `base.css` grants `corner-shape: squircle` to anything
  carrying a `rounded-*` class, with one exception: `rounded-full` opts out. Use
  `rounded-[999px]` for a pill or circle that should stay a squircle, and
  `rounded-full` only where a true circle is wanted.
- Align a heading with the content inside the rows under it, not with the row's
  outer edge. A grouped list reads as a label over its items only when the two
  share an x. Row pages get there by outdenting the list past the content edge
  (`-mx-3` with `px-3` on rows and labels, see `lib/archived-classes.ts`); card
  pages get there by indenting the headings by the card's padding (see
  `PEOPLE_INSET`). Pick one inset per page and use it for both.
- Compose classes with `cn()`. Accept and merge `className` in shared
  primitives so callers can adjust layout without copying the component.
- Paint interaction states with the hover washes — `hover:bg-hover` /
  `bg-pressed` in Tailwind, `var(--hover)` / `var(--hover-strong)` in
  `base.css`. They are translucent ink, so one token reads at the same
  strength on any surface. Do not use `--bg-hover` or `--bg-raised` as a hover:
  they are absolute surfaces, so they land as a heavy wash on `--bg` and a
  nearly invisible one on `--bg-panel`, and `--bg-raised` steps the wrong way in
  one theme. `--bg-hover` stays for the few real surfaces built on it (the
  segmented-control track, the scroll-fade `box-shadow` masks).
- Keep a hover wash proportional to the control. A small icon button should
  paint roughly the box its neighbours do, not its whole 40px target — see
  `paletteIconBtn` in `lib/palette-classes.ts`, which paints on a
  pseudo-element inset by 4px (`before:inset-1`).
- Follow the existing spacing, type, radius, border, and icon scales. Prefer a
  nearby shared component or token over a new arbitrary value.
- Reach for the breakpoint by name: `phone:` and `desktop:`, defined in
  `styles/tailwind.css`. Do not spell it `max-[720px]:` — that compiles to
  `< 720`, not `<= 720`, so at exactly 720px wide the element drops its phone
  value while `base.css`'s own `@media (max-width: 720px)` block keeps one.
- Match the surrounding surface before adding visual emphasis. Accent colors,
  raised surfaces, shadows, and animation should communicate meaning, not make
  a new feature louder than its neighbors.
- Add rules to `styles/base.css` only when they are truly global or
  theme-level — tokens, resets, platform chrome, and the keyframes and
  `@property` registrations that have no element to hang a utility on. Never
  add to `styles/legacy.css`: it is empty on purpose. Component styling belongs
  with the component, as utilities or a primitive in `ui/`.

## Interaction and accessibility

- Use semantic HTML first. Every interactive element must work with a keyboard
  and expose an accessible name; do not make a clickable `div`.
- Preserve visible focus, disabled, loading, error, empty, hover, and pressed
  states. Hover may enhance a control but cannot be the only way to discover or
  operate it.
- Keep touch targets usable on mobile and verify layouts at both desktop and
  phone widths. A desktop-only success is not a finished UI change.
- Use the motion guidance and shared presets from the root `AGENTS.md`. Motion
  should clarify state or spatial relationships, remain interruptible where
  appropriate, and respect reduced-motion preferences.
- Keep destructive actions clearly named and visually distinct. Confirm only
  actions that are difficult or impossible to undo.

## React and verification

- Follow the existing React 19 patterns. Do not add `useMemo` or `useCallback`
  by default; no React Compiler is configured in the build (Bun.build in
  frontend-build.ts has no compiler plugin), so memoize manually — and only
  where a measured re-render cost justifies it.
- Keep component files component-only: put non-component helpers/constants in
  `lib/` or `ui/` modules, because mixed component+helper exports disqualify a
  module from React Fast Refresh and downgrade every edit to a full page
  reload.
- Keep state close to where it is used. Do not add a new context, store, or
  abstraction for state that belongs to one component tree.
- Run `bun run typecheck` and the relevant `bun test` targets after code
  changes. For visible changes, verify the real page at desktop and mobile
  sizes and exercise keyboard interaction, loading, empty, and error states
  that the change affects.
