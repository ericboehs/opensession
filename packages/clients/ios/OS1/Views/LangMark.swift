import Foundation
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The file-type badge worn by the turn footer's file chips: a language's
/// brand mark where its logo still reads at this size, its letters otherwise.
///
/// The badge carries no fill of its own. A chip's faint wash belongs to the
/// whole chip, so the mark, the name and the counts read as one object rather
/// than as a coloured plate with a filename parked after it. This mirrors the
/// web's `ExtBadge`; before it, the native chip drew white letters on a filled
/// language-coloured tile, and a footer naming seven files put seven competing
/// plates in a row.
struct ExtBadge: View {
    /// The file's name. Only its extension is read.
    let name: String

    @ScaledMetric(relativeTo: .caption) private var markSize: CGFloat = 11
    @ScaledMetric(relativeTo: .caption) private var letterSize: CGFloat = 10
    @ScaledMetric(relativeTo: .caption) private var box: CGFloat = 15

    var body: some View {
        let ext = LangMark.ext(of: name)
        content(for: ext)
            .foregroundStyle(LangMark.ink(for: ext))
            .frame(minWidth: box, minHeight: box)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private func content(for ext: String) -> some View {
        if let mark = LangMark.mark(for: ext) {
            // `BrandLogoShape` aspect-fits and centres, so a square frame
            // sizes the mark's LONGER side, which is what the web's
            // ink-cropped viewBox does too. Never clip it: the drawing sits
            // ON the viewBox edge, and a clip shaves the tips off React's
            // diagonals.
            BrandLogoShape(logo: mark)
                .frame(width: markSize, height: markSize)
        } else {
            Text(LangMark.label(for: ext))
                .font(.system(size: letterSize, weight: .bold))
                .monospacedDigit()
                .offset(y: LangMark.capCentringOffset(size: letterSize))
        }
    }
}

/// Which mark, which letters and which ink a file extension wears. The tables
/// mirror the web's `LANG_MARKS`, `extLabel` and `EXT_COLORS`, so one language
/// looks the same in both clients.
enum LangMark {
    /// A filename's extension, lowercased, or "" when it has none. Mirrors
    /// the web's `fileExt`, dotfiles included: `.gitignore` is a name, not an
    /// extension.
    static func ext(of name: String) -> String {
        guard let dot = name.lastIndex(of: "."),
              dot != name.startIndex,
              dot != name.index(before: name.endIndex)
        else { return "" }
        return name[name.index(after: dot)...].lowercased()
    }

    /// An extension keeps its real name up to four characters and is cut to
    /// three beyond that. A blind three-letter cut spelled "JSO", "YAM",
    /// "SCS" and "JAV", word-shaped enough to read as a typo rather than an
    /// abbreviation, and the badge is elastic, so the fourth character costs
    /// a few points. Mirrors the web's `extLabel`.
    static func label(for ext: String) -> String {
        if ext.isEmpty { return "?" }
        return (ext.count <= 4 ? ext : String(ext.prefix(3))).uppercased()
    }

    static func mark(for ext: String) -> BrandLogo? { marks[ext] }

    /// How far to move all-caps text so its INK centres where a brand mark's
    /// does. Positive moves down.
    ///
    /// A brand mark is centred on its drawing; a `Text` is centred on its line
    /// box, which reserves room under the baseline for descenders that "SH"
    /// and "MJS" do not have. Centring the box therefore leaves the letters
    /// sitting lower than the mark beside them, and lower than the counts at
    /// the other end of the chip, which are cap-height too. The web has the
    /// same problem and answers it with a flat 1px nudge; the metrics are
    /// right here and scale with Dynamic Type, so use them.
    static func capCentringOffset(size: CGFloat) -> CGFloat {
        #if os(macOS)
        let font = NSFont.systemFont(ofSize: size, weight: .bold)
        #else
        let font = UIFont.systemFont(ofSize: size, weight: .bold)
        #endif
        // `descender` is negative, so this is (cap - (ascent - |descent|)) / 2.
        return (font.capHeight - font.ascender - font.descender) / 2
    }

    /// The language's hue, mixed a quarter of the way toward the
    /// appearance's own text colour, exactly as the web's
    /// `color-mix(in oklab, <hue> 75%, var(--text))` does. That lift settles
    /// the bright hues on a light chip and rescues the dark ones (Ruby's
    /// #701516, JSON's #953800) on a dark one, from one expression and
    /// without a second palette to keep in sync.
    static func ink(for ext: String) -> Color { inks[ext] ?? fallbackInk }

    /// The resolved badge ink in each appearance. For tests; views want
    /// `ink(for:)`.
    static func inkComponents(for ext: String) -> InkPair {
        let hue = hues[ext] ?? fallbackHue
        return InkPair(
            light: Oklab.mix(hue, 0.75, with: RGB(red: 0, green: 0, blue: 0)),
            dark: Oklab.mix(hue, 0.75, with: RGB(red: 1, green: 1, blue: 1))
        )
    }

    struct InkPair: Equatable {
        var light: RGB
        var dark: RGB
    }

    // MARK: - Tables

    /// Extension to mark, mirroring the web's `LANG_MARKS`. Anything absent
    /// falls back to the badge's letters, which is no loss: "GO", "MD" and
    /// "SVG" are already the whole name, and TypeScript, JavaScript and CSS
    /// have never been anything but letters.
    ///
    /// A four-thousand-character path is parsed once per size and cached by
    /// `BrandLogoShape`, so a footer of chips pays for a mark once.
    private static let marks: [String: BrandLogo] = [
        "res": .reScript,
        "resi": .reScript,
        "swift": .swift,
        "html": .html5,
        "tsx": .react,
        "jsx": .react,
        "rs": .rust,
        "toml": .toml,
        "rb": .ruby,
        "py": .python,
    ]

    /// Linguist's hues, as the web's `EXT_COLORS` has them. These are the
    /// SOURCE colours, not display values: `ink(for:)` mixes each one toward
    /// the appearance's text before it is painted.
    private static let hues: [String: RGB] = [
        "ts": RGB(hex: 0x3178c6),
        "tsx": RGB(hex: 0x3178c6),
        "js": RGB(hex: 0xa38319),
        "jsx": RGB(hex: 0xa38319),
        "mjs": RGB(hex: 0xa38319),
        "cjs": RGB(hex: 0xa38319),
        "css": RGB(hex: 0x663399),
        "scss": RGB(hex: 0xc6538c),
        "html": RGB(hex: 0xe34c26),
        "md": RGB(hex: 0x0969da),
        "mdx": RGB(hex: 0x0969da),
        "json": RGB(hex: 0x953800),
        "yaml": RGB(hex: 0xcb171e),
        "yml": RGB(hex: 0xcb171e),
        "toml": RGB(hex: 0x9c4221),
        "sh": RGB(hex: 0x459721),
        "bash": RGB(hex: 0x459721),
        "py": RGB(hex: 0x3572a5),
        "rs": RGB(hex: 0xb7410e),
        "go": RGB(hex: 0x0091b5),
        "rb": RGB(hex: 0x701516),
        "swift": RGB(hex: 0xf05138),
        "java": RGB(hex: 0xb07219),
        "sql": RGB(hex: 0xbf7600),
        "svg": RGB(hex: 0xca6f06),
        // Linguist's ReScript red (#ed5051) is the loudest hue in this map, so
        // it is darkened to sit with its neighbours, as on the web.
        "res": RGB(hex: 0xc93a3c),
        "resi": RGB(hex: 0xc93a3c),
    ]

    private static let fallbackHue = RGB(hex: 0x6e7681)

    private static let inks: [String: Color] = hues.mapValues { LangMark.dynamic(mixing: $0) }
    private static let fallbackInk: Color = LangMark.dynamic(mixing: LangMark.fallbackHue)

    /// The mix resolves against pure black and pure white because that is what
    /// `.label` is in each appearance, so both endpoints can be computed once
    /// instead of per draw.
    private static func dynamic(mixing hue: RGB) -> Color {
        let light = Oklab.mix(hue, 0.75, with: RGB(red: 0, green: 0, blue: 0))
        let dark = Oklab.mix(hue, 0.75, with: RGB(red: 1, green: 1, blue: 1))
        #if os(macOS)
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? dark.nsColor
                : light.nsColor
        })
        #else
        return Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark.uiColor : light.uiColor
        })
        #endif
    }
}

/// An sRGB colour as the mix works on it: components in 0...1, no alpha,
/// because both ends of a badge mix are opaque.
struct RGB: Equatable {
    var red: Double
    var green: Double
    var blue: Double

    init(red: Double, green: Double, blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    init(hex: UInt32) {
        red = Double((hex >> 16) & 0xff) / 255
        green = Double((hex >> 8) & 0xff) / 255
        blue = Double(hex & 0xff) / 255
    }

    #if os(macOS)
    var nsColor: NSColor {
        NSColor(srgbRed: red, green: green, blue: blue, alpha: 1)
    }
    #else
    var uiColor: UIColor {
        UIColor(red: red, green: green, blue: blue, alpha: 1)
    }
    #endif
}

/// Björn Ottosson's Oklab, enough of it to reproduce one CSS expression.
///
/// `color-mix(in oklab, ...)` converts both colours to Oklab, interpolates,
/// and converts back. Doing it by hand rather than through `Color.mix(_:by:)`
/// keeps the result assertable: the system's "perceptual" space is documented
/// as perceptually uniform rather than contractually Oklab, and a parity claim
/// against the web needs a number, not a resemblance.
enum Oklab {
    struct Lab: Equatable {
        var lightness: Double
        var a: Double
        var b: Double
    }

    /// `weight` of `color`, the rest of `other`.
    static func mix(_ color: RGB, _ weight: Double, with other: RGB) -> RGB {
        let first = lab(from: color)
        let second = lab(from: other)
        return rgb(
            from: Lab(
                lightness: first.lightness * weight + second.lightness * (1 - weight),
                a: first.a * weight + second.a * (1 - weight),
                b: first.b * weight + second.b * (1 - weight)
            )
        )
    }

    static func lab(from color: RGB) -> Lab {
        let red = linear(color.red)
        let green = linear(color.green)
        let blue = linear(color.blue)
        let long = cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
        let medium = cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
        let short = cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)
        return Lab(
            lightness: 0.2104542553 * long + 0.7936177850 * medium - 0.0040720468 * short,
            a: 1.9779984951 * long - 2.4285922050 * medium + 0.4505937099 * short,
            b: 0.0259040371 * long + 0.7827717662 * medium - 0.8086757660 * short
        )
    }

    static func rgb(from lab: Lab) -> RGB {
        let long = pow(lab.lightness + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3)
        let medium = pow(lab.lightness - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3)
        let short = pow(lab.lightness - 0.0894841775 * lab.a - 1.2914855480 * lab.b, 3)
        // Clipped rather than gamut-mapped. A mix of two in-gamut sRGB colours
        // lands at most a rounding error outside it, so the two agree here;
        // anything that starts using wider primaries needs the real mapping.
        return RGB(
            red: encode(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
            green: encode(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
            blue: encode(-0.0041960863 * long - 0.7034186147 * medium + 1.7076147010 * short)
        )
    }

    private static func linear(_ value: Double) -> Double {
        value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
    }

    private static func encode(_ value: Double) -> Double {
        let clamped = min(1, max(0, value))
        return clamped <= 0.0031308
            ? 12.92 * clamped
            : 1.055 * pow(clamped, 1 / 2.4) - 0.055
    }
}
