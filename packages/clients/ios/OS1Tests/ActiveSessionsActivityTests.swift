import XCTest
@testable import OS1

final class ActiveSessionsActivityTests: XCTestCase {
    func testSnapshotKeepsOnlyOwnedRunningSessionsAndCapsVisibleRows() {
        let sessions = [
            session("os-1", title: "Newest", owner: "Michiel", running: true, at: "2026-08-11T10:04:00Z"),
            session("os-2", title: "Second", owner: "happylinks", running: true, at: "2026-08-11T10:03:00Z"),
            session("os-3", title: "Third", owner: "Michiel", running: true, at: "2026-08-11T10:02:00Z"),
            session("os-4", title: "Fourth", owner: "Michiel", running: true, at: "2026-08-11T10:01:00Z"),
            session("os-other", title: "Someone else", owner: "Kent", running: true, at: "2026-08-11T10:05:00Z"),
            session("os-idle", title: "Idle", owner: "Michiel", running: false, at: "2026-08-11T10:06:00Z"),
        ]

        let snapshot = ActiveSessionsSnapshot.make(
            from: sessions,
            userName: "Michiel Westerbeek",
            githubLogin: "happylinks",
            now: Date(timeIntervalSince1970: 123)
        )

        XCTAssertEqual(snapshot.totalCount, 4)
        XCTAssertEqual(snapshot.sessions.map(\.id), ["os-1", "os-2", "os-3"])
        XCTAssertEqual(snapshot.updatedAt, 123)
    }

    func testSnapshotCountsOnlyOwnedUnreadSessions() {
        let unread = session(
            "os-unread", title: "Unread", owner: "Michiel", running: false,
            at: "2026-08-11T10:00:00Z"
        )
        let read = session(
            "os-read", title: "Read", owner: "Michiel", running: false,
            at: "2026-08-11T10:01:00Z"
        )
        var worker = session(
            "os-worker", title: "Worker", owner: "Michiel", running: false,
            at: "2026-08-11T10:02:00Z"
        )
        worker.spawnedBy = unread.id
        let other = session(
            "os-other", title: "Other", owner: "Kent", running: false,
            at: "2026-08-11T10:04:00Z"
        )
        let unreadIDs = Set([unread.id, worker.id, other.id])

        let snapshot = ActiveSessionsSnapshot.make(
            from: [unread, read, worker, other],
            userName: "Michiel",
            githubLogin: "happylinks",
            isUnread: { unreadIDs.contains($0.id) }
        )

        XCTAssertEqual(snapshot.unreadCount, 1)
    }

    func testSnapshotDecodesOlderStateWithoutUnreadCount() throws {
        let data = Data(
            #"{"sessions":[],"totalCount":1,"updatedAt":100}"#.utf8
        )

        let snapshot = try JSONDecoder().decode(ActiveSessionsSnapshot.self, from: data)

        XCTAssertEqual(snapshot.unreadCount, 0)
    }

    func testVerifiedCreatorLoginWinsOverAmbiguousDisplayName() {
        var mine = session(
            "os-mine", title: "Mine", owner: "Alex", running: true,
            at: "2026-08-11T10:00:00Z"
        )
        mine.createdByLogin = "alex-one"
        var other = session(
            "os-other", title: "Other", owner: "Alex", running: true,
            at: "2026-08-11T10:01:00Z"
        )
        other.createdByLogin = "alex-two"

        let snapshot = ActiveSessionsSnapshot.make(
            from: [mine, other],
            userName: "Alex",
            githubLogin: "alex-one"
        )

        XCTAssertEqual(snapshot.sessions.map(\.id), ["os-mine"])
    }

    func testSnapshotExcludesDeskAndBoundsPrivateText() {
        var regular = session(
            "os-regular",
            title: String(repeating: "t", count: 100),
            owner: "Michiel",
            running: true,
            at: "2026-08-11T10:00:00Z"
        )
        regular.repo = String(repeating: "r", count: 60)
        var desk = session(
            "os-desk", title: "Private desk", owner: "Michiel", running: true,
            at: "2026-08-11T10:01:00Z"
        )
        desk.desk = true

        let snapshot = ActiveSessionsSnapshot.make(
            from: [regular, desk],
            userName: "Michiel",
            githubLogin: ""
        )

        XCTAssertEqual(snapshot.sessions.map(\.id), ["os-regular"])
        XCTAssertEqual(snapshot.sessions[0].title.count, 80)
        XCTAssertEqual(snapshot.sessions[0].repo.count, 40)
    }

    func testRepoLessSnapshotDoesNotShowTheDefaultRepo() {
        var repoLess = session(
            "os-repo-less", title: "Ask", owner: "Michiel", running: true,
            at: "2026-08-11T10:00:00Z"
        )
        repoLess.repoLess = true

        let snapshot = ActiveSessionsSnapshot.make(
            from: [repoLess], userName: "Michiel", githubLogin: ""
        )

        XCTAssertEqual(snapshot.sessions.first?.repo, "No repo")
    }

    private func session(
        _ id: String,
        title: String,
        owner: String,
        running: Bool,
        at: String
    ) -> Session {
        var session = Session(id: id)
        session.title = title
        session.startedBy = owner
        session.isRunning = running
        session.lastActivity = at
        session.repo = "opensession"
        return session
    }
}
