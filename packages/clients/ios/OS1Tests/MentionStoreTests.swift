import XCTest
@testable import OS1

@MainActor
final class MentionStoreTests: XCTestCase {
    private func mention(
        _ sessionId: String,
        by: String = "Kent",
        ts: Double = 1
    ) -> MentionRecord {
        MentionRecord(
            sessionId: sessionId,
            by: by,
            source: "prompt",
            preview: "Please look",
            ts: ts
        )
    }

    func testHydrationKeepsNewestRecordPerSession() {
        let store = MentionStore()
        store.applyHydrated([
            mention("os-1", by: "Kent", ts: 1),
            mention("os-1", by: "Grant", ts: 2),
            mention("os-2", ts: 3),
        ], persist: false)

        XCTAssertTrue(store.hasHydrated)
        XCTAssertEqual(store.sessionIds, ["os-1", "os-2"])
        XCTAssertEqual(store.mentions["os-1"]?.by, "Grant")
    }

    func testRESTPayloadDecodesMentionRecord() throws {
        struct Response: Decodable { var mentions: [MentionRecord] }

        let response = try JSONDecoder().decode(
            Response.self,
            from: Data(#"{"mentions":[{"sessionId":"os-1","by":"Kent","source":"note","preview":"Please look","ts":1760000000000}]}"#.utf8)
        )

        XCTAssertEqual(response.mentions.first?.sessionId, "os-1")
        XCTAssertEqual(response.mentions.first?.source, "note")
    }

    func testNewestWorkspaceMentionDrivesBadgeSender() throws {
        let store = MentionStore()
        store.applyHydrated([
            mention("os-1", by: "Kent", ts: 1),
            mention("os-2", by: "Grant", ts: 3),
            mention("os-3", by: "Jaap", ts: 2),
        ], persist: false)
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(#"[{"id":"os-1"},{"id":"os-2"}]"#.utf8)
        )

        XCTAssertEqual(store.mention(for: sessions)?.by, "Grant")
        XCTAssertNil(store.mention(for: []))
    }

    func testLiveFramesApplyOnlyForCurrentUserAndClearOneOrAll() {
        let store = MentionStore()
        let me = ServerConfig.shared.userName

        store.receive(user: "Someone else", mention: mention("os-other"), persist: false)
        store.receive(user: me, mention: mention("os-1"), persist: false)
        store.receive(user: me.uppercased(), mention: mention("os-2"), persist: false)
        XCTAssertEqual(store.sessionIds, ["os-1", "os-2"])

        store.receiveCleared(user: me, sessionId: "os-1")
        XCTAssertEqual(store.sessionIds, ["os-2"])
        store.receiveCleared(user: me, sessionId: nil)
        XCTAssertTrue(store.sessionIds.isEmpty)
    }

    func testOpenSessionClearsCurrentAndIncomingMentions() {
        let store = MentionStore()
        let me = ServerConfig.shared.userName
        store.applyHydrated([mention("os-1")], persist: false)

        store.open("os-1", persist: false)
        XCTAssertNil(store.mentions["os-1"])

        store.receive(user: me, mention: mention("os-1", ts: 2), persist: false)
        XCTAssertNil(store.mentions["os-1"])
        store.receive(user: me, mention: mention("os-2", ts: 3), persist: false)
        XCTAssertNotNil(store.mentions["os-2"])

        store.close("os-1")
        store.receive(user: me, mention: mention("os-1", ts: 4), persist: false)
        XCTAssertNotNil(store.mentions["os-1"])
    }

    func testMentionAdmitsCrossOwnerWorkspaceToMyLens() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(#"[{"id":"os-1","workspaceId":"ws-1","startedBy":"Kent"}]"#.utf8)
        )
        let row = try XCTUnwrap(
            SessionsListViewModel.sidebarWorkspaces(in: sessions).first
        )

        XCTAssertFalse(PeopleLens(names: ["michiel"], claims: []).owns(row))
        XCTAssertTrue(
            PeopleLens(names: ["michiel"], claims: [], mentions: ["os-1"]).owns(row)
        )
    }

    func testMentionMovesWorkspaceIntoNeedsActionInboxBand() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(#"[{"id":"os-1","workspaceId":"ws-1","lastActivity":"2026-08-10T12:00:00Z"}]"#.utf8)
        )
        let rows = SessionsListViewModel.sidebarWorkspaces(in: sessions)
        let now = try XCTUnwrap(Session.parseISO("2026-08-17T12:00:00Z"))

        XCTAssertEqual(
            SessionsListViewModel.inboxBands(rows, now: now).first?.band,
            .earlier
        )
        XCTAssertEqual(
            SessionsListViewModel.inboxBands(
                rows,
                mentionedSessionIds: ["os-1"],
                now: now
            ).first?.band,
            .needsAction
        )
    }
}
