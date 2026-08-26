#if os(macOS)
import AppKit
import SwiftUI
import XCTest
@testable import OS1

/// The status inks, measured rather than eyeballed.
///
/// `OS1VisualStyle.green` and friends are the web's dark-theme values used in
/// both appearances, which is why the `*Ink` tokens exist: a dot can carry a
/// low ratio because the words beside it say the same thing, and the words
/// cannot. This asserts the promise those tokens make, so a later "simplify"
/// that points an ink back at the palette fails here instead of on a phone in
/// daylight.
///
/// The surfaces are the two ends of what the app actually paints ink on: white
/// at the top, and #ECECEC at the bottom (the Mac's window background, which
/// is the transcript canvas there). Dark runs from black up to #1C1C1E.
final class StatusInkContrastTests: XCTestCase {
    // MARK: - Contrast

    /// WCAG 2.1 relative luminance.
    private func luminance(_ color: NSColor) -> CGFloat {
        guard let srgb = color.usingColorSpace(.sRGB) else {
            XCTFail("colour is not representable in sRGB")
            return 0
        }
        func channel(_ value: CGFloat) -> CGFloat {
            value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(srgb.redComponent)
            + 0.7152 * channel(srgb.greenComponent)
            + 0.0722 * channel(srgb.blueComponent)
    }

    private func ratio(_ a: NSColor, _ b: NSColor) -> CGFloat {
        let (first, second) = (luminance(a), luminance(b))
        return (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }

    /// A dynamic colour resolved in one appearance. Reading `NSColor(Color)`
    /// outside a drawing appearance gives whichever one the test host happens
    /// to be in, which is exactly the bug this file is about.
    private func resolve(_ color: Color, _ appearance: NSAppearance.Name) -> NSColor {
        var resolved = NSColor.clear
        NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance {
            resolved = NSColor(color).usingColorSpace(.sRGB) ?? .clear
        }
        return resolved
    }

    private func gray(_ white: CGFloat) -> NSColor {
        NSColor(srgbRed: white, green: white, blue: white, alpha: 1)
    }

    private var inks: [(name: String, color: Color)] {
        [
            ("greenInk", OS1VisualStyle.greenInk),
            ("yellowInk", OS1VisualStyle.yellowInk),
            ("blueInk", OS1VisualStyle.blueInk),
            ("redInk", OS1VisualStyle.redInk),
            ("purpleInk", OS1VisualStyle.purpleInk),
        ]
    }

    // MARK: - The promise

    func testEveryInkClearsBodyTextContrastInLightAppearance() {
        // White, and the lowest light surface the app paints ink on.
        for surface in [gray(1.0), gray(236.0 / 255.0)] {
            for ink in inks {
                let measured = ratio(resolve(ink.color, .aqua), surface)
                XCTAssertGreaterThanOrEqual(
                    measured, 4.5,
                    "\(ink.name) measures \(String(format: "%.2f", measured)):1 in light appearance"
                )
            }
        }
    }

    func testEveryInkClearsBodyTextContrastInDarkAppearance() {
        for surface in [gray(0), gray(30.0 / 255.0)] {
            for ink in inks {
                let measured = ratio(resolve(ink.color, .darkAqua), surface)
                XCTAssertGreaterThanOrEqual(
                    measured, 4.5,
                    "\(ink.name) measures \(String(format: "%.2f", measured)):1 in dark appearance"
                )
            }
        }
    }

    /// Why the tokens exist at all. If this ever passes, the palette has been
    /// changed per appearance and the inks are free to fold back into it.
    func testThePaletteItselfWouldFailAsTextOnALightSurface() {
        let palette: [(String, Color)] = [
            ("green", OS1VisualStyle.green),
            ("yellow", OS1VisualStyle.yellow),
            ("blue", OS1VisualStyle.blue),
            ("red", OS1VisualStyle.red),
            ("purple", OS1VisualStyle.purple),
        ]
        for (name, color) in palette {
            let measured = ratio(resolve(color, .aqua), gray(1.0))
            XCTAssertLessThan(
                measured, 4.5,
                "\(name) now clears 4.5:1 on white; the ink tokens can be retired"
            )
        }
    }

    /// Dark is meant to be untouched, so a status is one colour there.
    func testInkMatchesThePaletteInDarkAppearance() {
        let pairs: [(String, Color, Color)] = [
            ("green", OS1VisualStyle.greenInk, OS1VisualStyle.green),
            ("yellow", OS1VisualStyle.yellowInk, OS1VisualStyle.yellow),
            ("blue", OS1VisualStyle.blueInk, OS1VisualStyle.blue),
            ("red", OS1VisualStyle.redInk, OS1VisualStyle.red),
            ("purple", OS1VisualStyle.purpleInk, OS1VisualStyle.purple),
        ]
        for (name, ink, fill) in pairs {
            let inkColor = resolve(ink, .darkAqua)
            let fillColor = resolve(fill, .darkAqua)
            XCTAssertEqual(
                inkColor.redComponent, fillColor.redComponent, accuracy: 0.01, "\(name) red"
            )
            XCTAssertEqual(
                inkColor.greenComponent, fillColor.greenComponent, accuracy: 0.01, "\(name) green"
            )
            XCTAssertEqual(
                inkColor.blueComponent, fillColor.blueComponent, accuracy: 0.01, "\(name) blue"
            )
        }
    }
}
#endif
