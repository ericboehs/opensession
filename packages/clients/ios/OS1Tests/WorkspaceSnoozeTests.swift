import XCTest
@testable import OS1

final class WorkspaceSnoozeTests: XCTestCase {
    private func workspace(
        _ id: String,
        created: TimeInterval,
        activity: TimeInterval = 0
    ) -> SidebarWorkspace {
        var session = Session(id: id)
        session.createdAt = ISO8601DateFormatter().string(
            from: Date(timeIntervalSince1970: created)
        )
        session.lastActivity = ISO8601DateFormatter().string(
            from: Date(timeIntervalSince1970: activity)
        )
        return SidebarWorkspace(
            id: "session:\(id)",
            title: id,
            sessions: [session],
            mainSession: session
        )
    }

    func testSomeDayNeverLapses() {
        XCTAssertTrue(WorkspaceSnooze.isActive(
            WorkspaceSnooze.someDay,
            now: .distantFuture
        ))
    }

    func testTimedSnoozesWake() {
        let now = Date(timeIntervalSince1970: 1_000)
        let formatter = ISO8601DateFormatter()
        XCTAssertTrue(WorkspaceSnooze.isActive(
            formatter.string(from: Date(timeIntervalSince1970: 1_001)),
            now: now
        ))
        XCTAssertFalse(WorkspaceSnooze.isActive(
            formatter.string(from: Date(timeIntervalSince1970: 999)),
            now: now
        ))
    }

    func testInboxOrderUsesCreationRatherThanActivity() {
        let olderButBusy = workspace("older", created: 100, activity: 900)
        let newerButQuiet = workspace("newer", created: 200, activity: 300)
        XCTAssertEqual(
            WorkspaceSnooze.sortActive([olderButBusy, newerButQuiet]).map(\.title),
            ["newer", "older"]
        )
    }

    func testSomeDaySortsAfterTimedSnoozes() {
        let timed = workspace("timed", created: 100)
        let someday = workspace("someday", created: 200)
        let values = [
            SidebarRowKeys.rowKey(for: timed): "2027-01-01T09:00:00Z",
            SidebarRowKeys.rowKey(for: someday): WorkspaceSnooze.someDay,
        ]
        XCTAssertEqual(
            WorkspaceSnooze.sortSnoozed([someday, timed], values: values).map(\.title),
            ["timed", "someday"]
        )
    }
}
