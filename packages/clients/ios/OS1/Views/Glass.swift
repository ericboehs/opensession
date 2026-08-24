import SwiftUI

// Shared Liquid Glass styling for floating chrome — the composer, status
// chips, banners, the ask card. The app targets iOS 26 / macOS 26, so these
// use the real glass APIs directly.

extension View {
    /// Glass surface for floating chrome. `interactive` opts into the
    /// touch-responsive glass variant (for tappable surfaces).
    func glassSurface<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
        glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
    }

    /// Tinted glass surface (e.g. the ask-question card).
    func glassSurface<S: Shape>(tint: Color, in shape: S) -> some View {
        glassEffect(.regular.tint(tint.opacity(0.35)), in: shape)
    }

    /// Soft progressive fade where transcript content scrolls under the
    /// transparent navigation bar and the floating composer. The default
    /// hard edge blurs content into an opaque-looking band; soft keeps the
    /// transcript visible through both edges.
    ///
    /// The bottom edge only fades if the composer is attached as a *bar*
    /// (`safeAreaBar`, not `safeAreaInset`): that tells the scroll view its
    /// content travels behind the floating chrome.
    func softScrollEdges() -> some View {
        scrollEdgeEffectStyle(.soft, for: [.top, .bottom])
    }

    #if os(iOS)
    /// Extra wash under the floating composer, on top of the soft scroll edge
    /// effect. That effect fades a row as it travels behind the bar, but the
    /// rows that end up BELOW and beside the pill stay legible all the way to
    /// the home indicator; this ramps them into the page colour so the transcript
    /// visibly ends at the screen edge instead of running off it.
    ///
    /// It hangs off the COMPOSER, not the scroll view: an overlay on the
    /// scroll view is laid out inside its safe area, which `safeAreaBar` has
    /// already inset by the bar's height — so the gradient painted above the
    /// composer instead of below it (measured: rows under the pill byte
    /// identical, rows above it lightened).
    ///
    /// - Parameters:
    ///   - ramp: how far up from the bar's bottom edge the dissolve runs. It
    ///     has to stay inside the bar's own height (a taller value overflows
    ///     upward and dims content well above the composer).
    ///   - tail: page colour hung BELOW the bar. `ignoresSafeArea` does not
    ///     extend a `safeAreaBar` background into the home-indicator strip —
    ///     measured: rows there stayed ~50% legible — so the tail is what
    ///     covers it, and the negative padding is what lets it hang out.
    ///   - veil: the wash's MAXIMUM opacity. Deliberately short of 1: the transcript
    ///     should still be faintly there under the pill, the way it is behind
    ///     the glass, rather than stopping at a hard edge. At 0.62 a glyph that
    ///     the scroll edge effect has already lightened reads around 236 of 255
    ///     — present, not legible.
    func composerBottomWash(
        ramp: CGFloat = 56,
        tail: CGFloat = 72,
        veil: Double = 0.62
    ) -> some View {
        background(alignment: .bottom) {
            VStack(spacing: 0) {
                // Clear down to where the ramp begins — roughly the middle of
                // the resting pill, so nothing above the composer is touched.
                Color.clear
                // Weighted stops, not a plain two-colour ramp: opacity climbs
                // faster than linear and is at full veil before the bar's
                // bottom edge, so the transcript has already gone quiet by the time
                // it meets the tail. A linear ramp only peaks on its very last
                // row, which left rows readable right down to the strip.
                LinearGradient(
                    stops: [
                        .init(color: OS1VisualStyle.chatCanvas.opacity(0), location: 0),
                        .init(color: OS1VisualStyle.chatCanvas.opacity(veil * 0.55), location: 0.4),
                        .init(color: OS1VisualStyle.chatCanvas.opacity(veil), location: 0.8),
                        .init(color: OS1VisualStyle.chatCanvas.opacity(veil), location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: ramp)
                OS1VisualStyle.chatCanvas.opacity(veil)
                    .frame(height: tail)
            }
            .padding(.bottom, -tail)
            .allowsHitTesting(false)
        }
    }

    /// The top counterpart of `composerBottomWash`. The transcript travels
    /// behind the navigation bar and — when a workspace has more than one tab —
    /// behind the floating tab strip as well. This is what it dissolves into on
    /// the way: rows ramp into the page colour as they climb under the chrome,
    /// and are gone by the time they reach the glass.
    ///
    /// The wash REPLACES the system's soft scroll edge effect on this edge
    /// rather than sitting on top of it. That effect blurs and lightens the
    /// rows travelling under the bars — and then stops dead at the bottom of
    /// the safe area, so a row was half-dissolved on one pixel row and fully
    /// legible on the next. That cut is the full-width line people saw drawn
    /// under the tab strip; no wash painted over it can remove it, because it
    /// is a discontinuity in the thing underneath. With the effect hidden, one
    /// gradient owns the whole transition and can land on zero exactly where
    /// the chrome ends.
    ///
    /// It hangs off the TRANSCRIPT rather than the strip — the strip only exists
    /// when a workspace has two or more tabs, and the nav bar needs the wash
    /// either way. An overlay on the scroll view is laid out INSIDE the safe
    /// area the bars have already inset, so its top edge is exactly the bottom
    /// of the chrome: the gradient hangs upward from there on a negative inset
    /// and needs no measurement. (Measuring was the other half of the bug —
    /// a `GeometryReader` reading `safeAreaInsets.top` under `ignoresSafeArea`
    /// reported an inset that did not match the bars, which put the whole ramp
    /// behind the glass where it changed nothing.) The bars themselves are
    /// drawn by ancestors, so their glass still floats above this.
    ///
    /// Nothing BELOW the chrome is touched, deliberately. A ramp that carries
    /// on into the page dims the top of a transcript that is sitting still and
    /// has nothing under the bars at all — measured on a one-turn session,
    /// whose first bubble came up grey.
    ///
    /// ONE gradient, not a solid band stacked on a ramp: two adjacent
    /// translucent layers meet on a fractional pixel row that composites twice,
    /// which is its own hairline.
    ///
    /// - Parameters:
    ///   - ramp: how far UP from the bottom of the chrome the dissolve runs.
    ///     Everything above it is held at full veil. Roughly the height of the
    ///     tab strip: a row has to be gone by the time it reaches the pills,
    ///     since the gaps between them show whatever is behind. Longer ramps
    ///     look softer but leave rows half-legible against the glass.
    ///   - veil: the wash's opacity over the bars. Opaque by default because
    ///     system chrome owns that touch region; showing a control there makes
    ///     it look actionable even though UIKit cannot deliver the touch.
    func transcriptTopWash(
        ramp: CGFloat = 56,
        veil: Double = 1
    ) -> some View {
        // Enough to cover the tallest top chrome (status bar + nav bar + tab
        // strip) on any device, plus slack; the excess lands off-screen.
        let overshoot: CGFloat = 400
        let flat = overshoot / (overshoot + ramp)
        return scrollEdgeEffectHidden(true, for: .top).overlay(alignment: .top) {
            // Smoothstep, not linear or weighted stops. The dissolve is bounded
            // by two FLAT regions — full veil above, bare transcript below — so
            // a stop list that arrives at zero still moving leaves a
            // first-derivative break at its bottom edge, and a slope break in a
            // wash reads as a drawn line across the full width (Mach band).
            // Smoothstep leaves AND arrives with zero slope, so it meets both
            // flats invisibly while still holding near full veil where rows are
            // up against the glass.
            LinearGradient(
                stops: [
                    Gradient.Stop(
                        color: OS1VisualStyle.chatCanvas.opacity(veil),
                        location: 0
                    )
                ] + (0...16).map { step in
                    let t = Double(step) / 16
                    let eased = 1 - t * t * (3 - 2 * t)
                    return Gradient.Stop(
                        color: OS1VisualStyle.chatCanvas.opacity(veil * eased),
                        location: flat + (1 - flat) * CGFloat(t)
                    )
                },
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: overshoot + ramp)
            // The whole gradient hangs ABOVE the overlay's top edge, so its
            // last row — the transparent one — lands on the bottom of the
            // chrome.
            .padding(.top, -(overshoot + ramp))
            .allowsHitTesting(false)
        }
    }
    #endif
}
