import XCTest
@testable import OS1

final class AccentThemeTests: XCTestCase {
    func testPaletteHasSevenDistinctOptions() {
        XCTAssertEqual(AccentTheme.allCases.count, 7)
        XCTAssertEqual(
            Set(AccentTheme.allCases.map { "\($0.fills.light)-\($0.fills.dark)" }).count,
            AccentTheme.allCases.count
        )
    }

    /// The guard that makes replacing a colour safe: the palette's fixed glyph
    /// has to be readable on it in both appearances. 3:1 is WCAG's non-text
    /// contrast, which is what an arrow in a disc is. Honey is the one
    /// exception, asserted by name below rather than skipped quietly.
    func testEveryAccentCarriesALegibleGlyph() {
        for theme in AccentTheme.allCases where theme != .lime {
            for dark in [false, true] {
                let contrast = theme.glyphContrast(dark: dark)
                XCTAssertGreaterThan(
                    contrast, 3.0,
                    "\(theme.rawValue) (\(dark ? "dark" : "light")) glyph contrast \(contrast)"
                )
            }
        }
    }

    /// Every chromatic fill carries white. Black is the only one that inverts,
    /// because its own fill does.
    func testChromaticFillsUseTheirExpectedGlyphInk() {
        for theme in AccentTheme.allCases where theme != .mono {
            XCTAssertTrue(theme.glyphIsWhite(dark: false), "\(theme.rawValue) light fill")
            XCTAssertTrue(theme.glyphIsWhite(dark: true), "\(theme.rawValue) dark fill")
        }
        XCTAssertTrue(AccentTheme.mono.glyphIsWhite(dark: false))
        XCTAssertFalse(AccentTheme.mono.glyphIsWhite(dark: true))
    }

    /// Two accents cannot say "on" with their own fill: Honey is 1.3:1 against
    /// a white page in either appearance, and Black's fill turns white in dark
    /// mode. Both borrow Sky. Everything else, including Black on a light page,
    /// keeps its own colour, which is what stops this becoming a second palette.
    func testOnlyTheTwoAccentsThatCannotCarryAControlBorrowOne() {
        let borrowed = AccentTheme.sky.fills.dark
        XCTAssertEqual(AccentTheme.lime.controlFills.light, borrowed)
        XCTAssertEqual(AccentTheme.lime.controlFills.dark, borrowed)
        XCTAssertEqual(AccentTheme.mono.controlFills.light, AccentTheme.mono.fills.light)
        XCTAssertEqual(AccentTheme.mono.controlFills.dark, borrowed)
        for theme in AccentTheme.allCases where theme != .lime && theme != .mono {
            XCTAssertEqual(
                theme.controlFills.light, theme.fills.light, "\(theme.rawValue) light"
            )
            XCTAssertEqual(
                theme.controlFills.dark, theme.fills.dark, "\(theme.rawValue) dark"
            )
        }
    }

    /// The borrowed track has to carry the knob, which the platform draws
    /// white. 3:1 is WCAG's floor for a control against what sits on it.
    func testTheBorrowedControlFillCarriesAWhiteKnob() {
        for theme in [AccentTheme.lime, .mono] {
            for dark in [false, true] {
                let fill = dark ? theme.controlFills.dark : theme.controlFills.light
                XCTAssertGreaterThan(
                    contrast(fill, 0xFF_FF_FF), 3.0,
                    "\(theme.rawValue) (\(dark ? "dark" : "light")) control fill"
                )
            }
        }
    }

    func testDefaultsToSkyWhenNothingIsStored() {
        let store = AccentStore(defaults: scratchDefaults())
        XCTAssertEqual(store.theme, .sky)
    }

    func testUnknownStoredValueFallsBackRatherThanCrashing() {
        let defaults = scratchDefaults()
        defaults.set("chartreuse", forKey: AccentStore.defaultsKey)
        XCTAssertEqual(AccentStore(defaults: defaults).theme, .default)
    }

    /// Honey carries one value in both appearances, so it has to separate from
    /// a white page and a near-black one with the same colour. Its white glyph
    /// is the palette's one deliberate low-contrast pairing; the number is
    /// asserted here so the exception stays visible rather than being skipped.
    func testHoneySeparatesFromBothPagesAndKeepsItsWhiteGlyph() {
        XCTAssertEqual(AccentTheme.lime.fills.light, AccentTheme.lime.fills.dark)
        XCTAssertGreaterThan(
            contrast(AccentTheme.lime.fills.light, 0xFF_FF_FF), 1.5,
            "honey against a white page"
        )
        XCTAssertGreaterThan(
            contrast(AccentTheme.lime.fills.dark, 0x1C_1C_1C), 3.0,
            "honey against the dark plate"
        )
        XCTAssertEqual(AccentTheme.lime.glyphContrast(dark: false), 1.62, accuracy: 0.02)
    }

    /// A retired accent must never point at another retired one: the switch
    /// runs once, so a chain would leave the store on a dead raw value and fall
    /// back to the default, which is the reset the migration exists to prevent.
    func testEveryRetiredSelectionMigratesToASurvivingAccent() {
        for (retired, expected) in [
            ("purple", AccentTheme.coral),
            ("pink", .coral),
            ("brown", .orange),
            ("teal", .sky),
            ("gold", .lime),
            ("blue", .sky),
        ] {
            let defaults = scratchDefaults()
            defaults.set(retired, forKey: AccentStore.defaultsKey)
            XCTAssertEqual(AccentStore(defaults: defaults).theme, expected, retired)
            XCTAssertEqual(
                defaults.string(forKey: AccentStore.defaultsKey), expected.rawValue, retired
            )
        }
    }

    func testSelectionPersists() {
        let defaults = scratchDefaults()
        let store = AccentStore(defaults: defaults)
        store.theme = .coral
        XCTAssertEqual(defaults.string(forKey: AccentStore.defaultsKey), "coral")
        XCTAssertEqual(AccentStore(defaults: defaults).theme, .coral)
    }

    /// WCAG contrast between two packed sRGB values. The production copy is
    /// file-private, and a second one here is the point: a test that reuses the
    /// implementation it is checking proves only that it is self-consistent.
    private func contrast(_ a: UInt32, _ b: UInt32) -> Double {
        func luminance(_ hex: UInt32) -> Double {
            let channels = [(hex >> 16) & 0xFF, (hex >> 8) & 0xFF, hex & 0xFF]
                .map { component -> Double in
                    let c = Double(component) / 255
                    return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
                }
            return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
        }
        let (first, second) = (luminance(a), luminance(b))
        return (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }

    private func scratchDefaults() -> UserDefaults {
        let suite = "AccentThemeTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        return defaults
    }
}
