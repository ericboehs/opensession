import XCTest
@testable import OS1

final class SupportLocationTests: XCTestCase {
    func testReadsTheThreeLocationsFromBothPreferences() {
        XCTAssertEqual(
            SupportLocation.current(hiddenTools: #"["plain"]"#, hiddenFeeds: "[]"),
            .sidebar
        )
        XCTAssertEqual(
            SupportLocation.current(hiddenTools: "[]", hiddenFeeds: #"["plain"]"#),
            .page
        )
        XCTAssertEqual(
            SupportLocation.current(
                hiddenTools: #"["plain"]"#,
                hiddenFeeds: #"["plain"]"#
            ),
            .off
        )
    }

    func testLegacyBothVisibleStateResolvesToTheSidebar() {
        XCTAssertEqual(
            SupportLocation.current(hiddenTools: "[]", hiddenFeeds: "[]"),
            .sidebar
        )
    }

    func testEachChoiceWritesBothPreferencesWithoutDroppingOtherIds() {
        let startTools = #"["analytics","plain"]"#
        let startFeeds = #"["linear"]"#

        let page = SupportLocation.setting(
            .page,
            hiddenTools: startTools,
            hiddenFeeds: startFeeds
        )
        XCTAssertEqual(SidebarTools.decode(page.hiddenTools), ["analytics"])
        XCTAssertEqual(SidebarFeeds.decode(page.hiddenFeeds), ["linear", "plain"])
        XCTAssertEqual(
            SupportLocation.current(
                hiddenTools: page.hiddenTools,
                hiddenFeeds: page.hiddenFeeds
            ),
            .page
        )

        let sidebar = SupportLocation.setting(
            .sidebar,
            hiddenTools: page.hiddenTools,
            hiddenFeeds: page.hiddenFeeds
        )
        XCTAssertEqual(SidebarTools.decode(sidebar.hiddenTools), ["analytics", "plain"])
        XCTAssertEqual(SidebarFeeds.decode(sidebar.hiddenFeeds), ["linear"])
        XCTAssertEqual(
            SupportLocation.current(
                hiddenTools: sidebar.hiddenTools,
                hiddenFeeds: sidebar.hiddenFeeds
            ),
            .sidebar
        )

        let off = SupportLocation.setting(
            .off,
            hiddenTools: sidebar.hiddenTools,
            hiddenFeeds: sidebar.hiddenFeeds
        )
        XCTAssertEqual(SidebarTools.decode(off.hiddenTools), ["analytics", "plain"])
        XCTAssertEqual(SidebarFeeds.decode(off.hiddenFeeds), ["linear", "plain"])
        XCTAssertEqual(
            SupportLocation.current(
                hiddenTools: off.hiddenTools,
                hiddenFeeds: off.hiddenFeeds
            ),
            .off
        )
    }

    func testAChoiceNeverShowsBothNativeSurfaces() {
        for toolsHidden in [false, true] {
            for feedsHidden in [false, true] {
                let tools = toolsHidden ? #"["plain"]"# : "[]"
                let feeds = feedsHidden ? #"["plain"]"# : "[]"
                let location = SupportLocation.current(hiddenTools: tools, hiddenFeeds: feeds)
                XCTAssertFalse(location == .sidebar && location == .page)
            }
        }
    }
}
