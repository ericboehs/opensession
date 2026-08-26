import SwiftUI

/// The colours ANSI codes resolve to, per appearance.
///
/// A terminal palette cannot be copied across surfaces, for the reason the
/// code well already learned: the canvas decides. The raw ANSI colours assume
/// a black background, and half of them (yellow, white, bright anything) are
/// unreadable the moment the well is light. So each slot has two values, and
/// the ones here are GitHub's light and dark ANSI sets, which are chosen for
/// exactly this job: legible on a near-white and a near-black well.
enum TerminalPalette {
    /// The 16 named slots, light appearance first.
    private static let base: [(light: UInt32, dark: UInt32)] = [
        (0x24292F, 0x6E7681), // black
        (0xCF222E, 0xFF7B72), // red
        (0x116329, 0x3FB950), // green
        (0x7D4E00, 0xD29922), // yellow · brown on light, or it disappears
        (0x0550AE, 0x58A6FF), // blue
        (0x8250DF, 0xBC8CFF), // magenta
        (0x1B7C83, 0x39C5CF), // cyan
        (0x6E7781, 0xB1BAC4), // white
        (0x57606A, 0x8B949E), // bright black
        (0xA40E26, 0xFFA198), // bright red
        (0x1A7F37, 0x56D364), // bright green
        (0x633C01, 0xE3B341), // bright yellow
        (0x218BFF, 0x79C0FF), // bright blue
        (0xA475F9, 0xD2A8FF), // bright magenta
        (0x3192AA, 0x56D4DD), // bright cyan
        (0x8C959F, 0xF0F6FC), // bright white
    ]

    /// What a run of text is painted with. `nil` ink is the well's own text
    /// colour, which is what most output is and what must stay perfect.
    static func color(for ink: TerminalStyle.Ink?, dim: Bool) -> Color {
        guard let ink else {
            return dim ? OS1VisualStyle.textDim : OS1VisualStyle.codeWellText
        }
        switch ink {
        case .indexed(let index):
            return indexed(index)
        case .rgb(let r, let g, let b):
            // A 24-bit colour was chosen by the program, not by us, so it is
            // used as given rather than second-guessed. Programs that emit
            // these overwhelmingly do it for syntax highlighting, which is
            // already tuned for a terminal.
            return Color(
                red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255
            )
        }
    }

    private static func indexed(_ index: Int) -> Color {
        if index >= 0, index < base.count {
            let slot = base[index]
            return dynamic(light: slot.light, dark: slot.dark)
        }
        if index >= 232, index <= 255 {
            // The 24-step grey ramp. Read straight through it would be
            // invisible at one end of each appearance, so it is compressed
            // into the readable half: dark greys on light, light on dark.
            let step = Double(index - 232) / 23
            return dynamic(
                light: grey(0.45 - step * 0.35),
                dark: grey(0.45 + step * 0.45)
            )
        }
        if index >= 16, index <= 231 {
            // The 6x6x6 cube.
            let offset = index - 16
            let levels: [Double] = [0, 0.373, 0.529, 0.686, 0.843, 1]
            let r = levels[(offset / 36) % 6]
            let g = levels[(offset / 6) % 6]
            let b = levels[offset % 6]
            return dynamic(
                light: pack(scale(r, g, b, by: 0.72)),
                dark: pack(lift(r, g, b))
            )
        }
        return OS1VisualStyle.codeWellText
    }

    /// Pull a cube colour toward black so it holds up on a light well.
    private static func scale(
        _ r: Double, _ g: Double, _ b: Double, by factor: Double
    ) -> (Double, Double, Double) {
        (r * factor, g * factor, b * factor)
    }

    /// Lift the darkest cube colours off a dark well, leaving the rest alone.
    /// Scaling the whole triple keeps the hue the program asked for; clamping
    /// each channel on its own would not.
    private static func lift(_ r: Double, _ g: Double, _ b: Double) -> (Double, Double, Double) {
        let peak = max(r, g, b)
        guard peak > 0, peak < 0.45 else { return (r, g, b) }
        let gain = 0.45 / peak
        return (r * gain, g * gain, b * gain)
    }

    private static func pack(_ rgb: (Double, Double, Double)) -> UInt32 {
        let r = UInt32(max(0, min(255, rgb.0 * 255)))
        let g = UInt32(max(0, min(255, rgb.1 * 255)))
        let b = UInt32(max(0, min(255, rgb.2 * 255)))
        return r << 16 | g << 8 | b
    }

    private static func grey(_ level: Double) -> UInt32 {
        pack((level, level, level))
    }

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        #if os(iOS)
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? PlatformColorFromHex(dark) : PlatformColorFromHex(light)
        })
        #else
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? PlatformColorFromHex(dark) : PlatformColorFromHex(light)
        })
        #endif
    }
}

#if os(iOS)
private func PlatformColorFromHex(_ hex: UInt32) -> UIColor {
    UIColor(
        red: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: 1
    )
}
#else
private func PlatformColorFromHex(_ hex: UInt32) -> NSColor {
    NSColor(
        srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: 1
    )
}
#endif
