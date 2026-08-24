import XCTest
@testable import OS1

final class CodeDisplaySettingsTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "CodeDisplaySettingsTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    func testSharedDefaultsMatchNativeRenderer() {
        XCTAssertEqual(
            CodeDisplaySettings.load(from: defaults),
            CodeDisplaySettings.defaults
        )
        XCTAssertEqual(CodeDisplaySettings.defaults.style, .unified)
        XCTAssertFalse(CodeDisplaySettings.defaults.wrapLines)
        XCTAssertTrue(CodeDisplaySettings.defaults.highlightEdits)
        XCTAssertTrue(CodeDisplaySettings.defaults.showFileStats)
        XCTAssertEqual(CodeDisplaySettings.defaults.theme, .system)
    }

    func testRoundTripsOneSharedPreferenceSet() {
        let chosen = CodeDisplaySettings(
            style: .split,
            wrapLines: true,
            highlightEdits: false,
            showFileStats: false,
            theme: .dark
        )

        chosen.save(to: defaults)

        XCTAssertEqual(CodeDisplaySettings.load(from: defaults), chosen)
    }

    func testInvalidStoredEnumsFallBackWithoutDiscardingValidChoices() {
        defaults.set("columns", forKey: CodeDisplaySettings.styleKey)
        defaults.set("sepia", forKey: CodeDisplaySettings.themeKey)
        defaults.set(true, forKey: CodeDisplaySettings.wrapKey)

        let loaded = CodeDisplaySettings.load(from: defaults)

        XCTAssertEqual(loaded.style, .unified)
        XCTAssertEqual(loaded.theme, .system)
        XCTAssertTrue(loaded.wrapLines)
    }
}
