import SwiftUI
import XCTest
@testable import OS1

/// The file-type badge: which mark a file wears, which letters stand in when
/// no mark does, and what colour the ink comes out.
///
/// The badge is a port of the web's `ExtBadge`, so most of these assertions
/// are parity assertions. Where a number appears, it was computed from the
/// web's own expression rather than sampled from a screenshot.
final class LangMarkTests: XCTestCase {

    // MARK: - Extensions and labels

    func testExtensionIsLowercasedAndDropsTheDot() {
        XCTAssertEqual(LangMark.ext(of: "SessionView.Swift"), "swift")
        XCTAssertEqual(LangMark.ext(of: "reland-diag.mjs"), "mjs")
        XCTAssertEqual(LangMark.ext(of: "a.b.tsx"), "tsx")
    }

    /// A dotfile is a name, not an extension, and neither is a trailing dot.
    func testNamesWithoutAnExtension() {
        XCTAssertEqual(LangMark.ext(of: ".gitignore"), "")
        XCTAssertEqual(LangMark.ext(of: "Makefile"), "")
        XCTAssertEqual(LangMark.ext(of: "trailing."), "")
        XCTAssertEqual(LangMark.label(for: ""), "?")
    }

    /// Four characters survive; five are cut to three. A blind three-letter
    /// cut spells "JSO" and "YAM", which read as typos.
    func testLabelKeepsTheFourthCharacter() {
        XCTAssertEqual(LangMark.label(for: "json"), "JSON")
        XCTAssertEqual(LangMark.label(for: "yaml"), "YAML")
        XCTAssertEqual(LangMark.label(for: "scss"), "SCSS")
        XCTAssertEqual(LangMark.label(for: "md"), "MD")
        XCTAssertEqual(LangMark.label(for: "swift"), "SWI")
    }

    /// The badge keys its mark and its hue on the raw extension, never on the
    /// capped label. Keying on the label is what made every Swift file wear
    /// the fallback grey: "swift" arrives at a colour table as "SWI".
    func testSwiftIsRecognisedDespiteItsCappedLabel() {
        let file = TouchedFile(path: "OS1/Views/SessionView.swift", additions: 8, deletions: 4)
        XCTAssertEqual(file.ext, "swift")
        XCTAssertEqual(file.extensionBadge, "SWI")
        XCTAssertNotNil(LangMark.mark(for: file.ext))
        XCTAssertNotEqual(
            LangMark.inkComponents(for: file.ext),
            LangMark.inkComponents(for: "")
        )
    }

    func testTouchedFileWithoutAnExtension() {
        let file = TouchedFile(path: "scripts/deploy", additions: 1, deletions: 0)
        XCTAssertEqual(file.ext, "")
        XCTAssertEqual(file.extensionBadge, "?")
        XCTAssertNil(LangMark.mark(for: file.ext))
    }

    // MARK: - Marks

    /// The ten extensions the web draws a brand mark for, and nothing else.
    func testMarkedExtensionsMatchTheWeb() {
        let marked = ["res", "resi", "swift", "html", "tsx", "jsx", "rs", "toml", "rb", "py"]
        for ext in marked {
            XCTAssertNotNil(LangMark.mark(for: ext), "\(ext) should draw a mark")
        }
        for ext in ["ts", "js", "mjs", "md", "json", "go", "css", "sh", ""] {
            XCTAssertNil(LangMark.mark(for: ext), "\(ext) should draw letters")
        }
    }

    /// Every mark's ink must fill its ink-cropped viewBox. This is the whole
    /// numeric check on the path data: a mis-lexed arc flag, a swallowed
    /// coordinate or an inverted sweep all move the drawing off the box, and
    /// none of them can do that and still land inside a point of it.
    func testEveryMarkFillsItsViewBox() throws {
        for ext in ["res", "swift", "html", "tsx", "rs", "toml", "rb", "py"] {
            let mark = try XCTUnwrap(LangMark.mark(for: ext), ext)
            var drawn = Path()
            for data in mark.paths { drawn.addPath(SVGPath.parse(data)) }
            let bounds = drawn.boundingRect
            XCTAssertFalse(bounds.isEmpty, "\(ext): parsed to nothing")
            // A curve's bounding box is its control hull on some rasterisers
            // and its ink on others, so this asserts agreement to a point
            // rather than to a rounding error.
            let tolerance = 1.0
            XCTAssertEqual(bounds.minX, mark.viewBox.minX, accuracy: tolerance, "\(ext) minX")
            XCTAssertEqual(bounds.minY, mark.viewBox.minY, accuracy: tolerance, "\(ext) minY")
            XCTAssertEqual(bounds.maxX, mark.viewBox.maxX, accuracy: tolerance, "\(ext) maxX")
            XCTAssertEqual(bounds.maxY, mark.viewBox.maxY, accuracy: tolerance, "\(ext) maxY")
        }
    }

    /// ReScript's dot is a `<circle>` on the web, which `BrandLogo` cannot
    /// hold, so it is carried here as two half-turn arcs. The bar alone stops
    /// well short of the viewBox, so the dot is what fills the right of it.
    func testReScriptKeepsItsDot() throws {
        let mark = try XCTUnwrap(LangMark.mark(for: "res"))
        XCTAssertEqual(mark.paths.count, 2)
        let bar = SVGPath.parse(mark.paths[0]).boundingRect
        let dot = SVGPath.parse(mark.paths[1]).boundingRect
        XCTAssertEqual(dot.width, 59.366, accuracy: 0.05)
        XCTAssertEqual(dot.height, 59.366, accuracy: 0.05)
        XCTAssertGreaterThan(dot.maxX, bar.maxX + 40)
    }

    // MARK: - The path parser

    /// Arc flags carry no separator: in `a1 1 0 00-.5.5` the `00` is two
    /// flags, and a scanner that reads a float there swallows `00-.5` whole.
    func testArcFlagsAreReadOneCharacterAtATime() throws {
        let end = try XCTUnwrap(SVGPath.parse("M0 0a1 1 0 00-.5.5").currentPoint)
        XCTAssertEqual(end.x, -0.5, accuracy: 0.0001)
        XCTAssertEqual(end.y, 0.5, accuracy: 0.0001)
    }

    /// A second decimal point ends the current number, and a sign starts one.
    func testNumbersSplitWithoutSeparators() throws {
        let end = try XCTUnwrap(SVGPath.parse("M1.5.5L2-3").currentPoint)
        XCTAssertEqual(end.x, 2, accuracy: 0.0001)
        XCTAssertEqual(end.y, -3, accuracy: 0.0001)
        XCTAssertEqual(SVGPath.parse("M1.5.5").boundingRect.origin.y, 0.5, accuracy: 0.0001)
    }

    /// A coordinate set after `M` continues the subpath as a line, not as a
    /// second move: `M0 0 10 0 10 10` is two sides of a triangle.
    func testMoveRepeatsAsALine() {
        let bounds = SVGPath.parse("M0 0 10 0 10 10Z").boundingRect
        XCTAssertEqual(bounds.width, 10, accuracy: 0.0001)
        XCTAssertEqual(bounds.height, 10, accuracy: 0.0001)
    }

    /// A half-turn arc is two cubic slices, and both stay on the circle. One
    /// cubic across 180 degrees would bulge visibly past it.
    func testArcTracksItsCircle() {
        let bounds = SVGPath.parse("M0 0A10 10 0 0 1 20 0").boundingRect
        XCTAssertEqual(bounds.width, 20, accuracy: 0.05)
        XCTAssertEqual(bounds.height, 10, accuracy: 0.05)
    }

    /// Closepath takes no coordinates, so a number after it cannot repeat it.
    /// Left pending, it spun here forever without consuming a byte, which is
    /// a hang rather than a wrong drawing.
    func testStrayNumbersAfterCloseDoNotHang() {
        XCTAssertFalse(SVGPath.parse("M0 0 10 0 10 10Z5 5").boundingRect.isEmpty)
        XCTAssertTrue(SVGPath.parse("5 5").isEmpty)
        XCTAssertFalse(SVGPath.parse("M0 0L").isEmpty)
    }

    // MARK: - Centring

    /// All-caps letters have no descender, so a `Text` centred on its line box
    /// sits lower than the brand mark beside it. Measured on the shipped
    /// build, every badge sat 0.8pt to 1.3pt below its chip; the correction
    /// lifts the letters the rest of the way onto the mark's line.
    func testCapCentringLiftsLettersOntoTheMarksLine() {
        for size in [8.0, 10.0, 13.0, 20.0] as [CGFloat] {
            let offset = LangMark.capCentringOffset(size: size)
            // Upward, and a fraction of the type size rather than a nudge
            // that would show as a misalignment of its own.
            XCTAssertLessThan(offset, 0, "\(size)pt should lift, not drop")
            XCTAssertGreaterThan(offset, -size * 0.12, "\(size)pt lifts too far")
        }
    }

    /// It has to scale with the type, which is the whole reason it is computed
    /// from the font rather than written down as the web's flat 1px.
    func testCapCentringScalesWithTheType() {
        let small = LangMark.capCentringOffset(size: 10)
        let large = LangMark.capCentringOffset(size: 20)
        XCTAssertEqual(large, small * 2, accuracy: 0.05)
    }

    // MARK: - Ink

    /// The web paints `color-mix(in oklab, <hue> 75%, var(--text))`, and
    /// `.label` is pure black or pure white, so the two endpoints are fixed.
    /// These are that expression's own answers, computed from the web's hues.
    func testInkMatchesTheWebsOklabMix() {
        let expected: [String: (light: UInt32, dark: UInt32)] = [
            "swift": (0xa33423, 0xfa836d),
            "py": (0x214b6f, 0x6894bc),
            "md": (0x044594, 0x5591e6),
            "rb": (0x4a0a0b, 0x97524c),
            "mjs": (0x6e570d, 0xb9a25f),
            "": (0x494e56, 0x90969f),
        ]
        for (ext, want) in expected {
            let ink = LangMark.inkComponents(for: ext)
            assertColor(ink.light, isHex: want.light, "\(ext) light")
            assertColor(ink.dark, isHex: want.dark, "\(ext) dark")
        }
    }

    /// Mixing a quarter of the text colour in is what makes a badge readable:
    /// on a light chip the raw hues fall under 3:1, which is where a glyph
    /// stops being a glyph and becomes a smudge.
    func testInkClearsItsChipInBothAppearances() {
        let lightChip = RGB(red: 0.980 * 0.95, green: 0.980 * 0.95, blue: 0.980 * 0.95)
        let darkChip = RGB(red: 0.05, green: 0.05, blue: 0.05)
        for ext in ["ts", "js", "css", "html", "md", "json", "yaml", "sh", "py", "rs",
                    "go", "rb", "swift", "java", "sql", "svg", "res", "scss", "toml", ""] {
            let ink = LangMark.inkComponents(for: ext)
            XCTAssertGreaterThan(contrast(ink.light, lightChip), 3, "\(ext) on a light chip")
            XCTAssertGreaterThan(contrast(ink.dark, darkChip), 3, "\(ext) on a dark chip")
        }
    }

    /// An unmapped extension gets the neutral, not a crash and not black.
    func testUnknownExtensionUsesTheFallbackHue() {
        XCTAssertEqual(
            LangMark.inkComponents(for: "wat"),
            LangMark.inkComponents(for: "")
        )
    }

    // MARK: - Helpers

    private func assertColor(
        _ color: RGB,
        isHex hex: UInt32,
        _ message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let want = RGB(hex: hex)
        // Within half a step of 8-bit, i.e. the same colour once rounded.
        let tolerance = 0.5 / 255
        XCTAssertEqual(color.red, want.red, accuracy: tolerance, "\(message) red", file: file, line: line)
        XCTAssertEqual(color.green, want.green, accuracy: tolerance, "\(message) green", file: file, line: line)
        XCTAssertEqual(color.blue, want.blue, accuracy: tolerance, "\(message) blue", file: file, line: line)
    }

    private func contrast(_ first: RGB, _ second: RGB) -> Double {
        let ordered = [relativeLuminance(first), relativeLuminance(second)].sorted(by: >)
        return (ordered[0] + 0.05) / (ordered[1] + 0.05)
    }

    private func relativeLuminance(_ color: RGB) -> Double {
        func linear(_ value: Double) -> Double {
            value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(color.red)
            + 0.7152 * linear(color.green)
            + 0.0722 * linear(color.blue)
    }
}
