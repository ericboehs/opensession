import XCTest
@testable import OS1

@MainActor
final class AutomationLinksTests: XCTestCase {
    private let id = "auto-019fffbe-997a-7000-8d11-a27c0b1d8452"

    func testLinksCodespanAndBareAutomationIds() {
        XCTAssertEqual(
            chipsAsLinks(AutomationLinks.linkify("ran `\(id)`")),
            "ran [auto-019fffbe…](os1automation:\(id))"
        )
        XCTAssertEqual(
            chipsAsLinks(AutomationLinks.linkify("ran \(id) just now")),
            "ran [auto-019fffbe…](os1automation:\(id)) just now"
        )
    }

    func testLeavesOrdinaryAutoCodespansAlone() {
        XCTAssertEqual(AutomationLinks.linkify("run `auto-fix`"), "run `auto-fix`")
    }

    func testTapResolvesAutomationId() {
        XCTAssertEqual(
            AutomationLinks.automationId(from: URL(string: "os1automation:\(id)")!),
            id
        )
        XCTAssertNil(AutomationLinks.automationId(from: URL(string: "https://example.com")!))
    }
}
