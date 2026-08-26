/**
 * A control's label centres on its CAP BAND, not on its line box.
 *
 * A line box carries the font's descender space whether or not the word uses
 * it, so centring one in a plate leaves that space empty under a word with no
 * descenders and puts the ink high. Measured on the workspace card's 26px
 * action: "Archive" sits 0.88px above centre, the `#5675` chip 0.75px, while
 * the same button reading "Archivey" sits 0.44px BELOW it. The cap band never
 * moved between those two, which is the tell: the browser is centring the box,
 * and only a descender fills the part of it that hangs below the baseline.
 *
 * `text-box` trims the box to cap height and baseline, so the centring lands
 * the ink itself. That is worth more than the pixel it buys: the correction is
 * font-dependent, and this app renders in SF, Inter or Segoe depending on the
 * platform, so a hand-tuned nudge is right in the font it was measured in and
 * wrong in the other two.
 *
 * Chrome 133+ and Safari 18.4+ trim it. Firefox centres the em box instead,
 * which lands within a pixel.
 *
 * Two things it needs to work. It has to sit on a plain string in its own
 * span, because `text-box` is a no-op on a flex container and so cannot ride
 * the control itself, and because an element child brings its own layout. And
 * the span must not be `inline-flex`: what gets trimmed is a plain span
 * blockified as a flex item.
 *
 * `ui/button` applies this to every label it is given; these are the controls
 * that are hand-rolled rather than built on it. `PrStatusBar` and
 * `ui/device-code` pair it with a half-pixel nudge, which is a separate and
 * deliberate optical choice made against their own neighbours, not part of
 * this rule.
 */
export const CAP_LABEL = "[text-box:trim-both_cap_alphabetic]";
