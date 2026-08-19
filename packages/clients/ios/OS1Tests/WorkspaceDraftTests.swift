import XCTest
@testable import OS1

@MainActor
final class WorkspaceDraftTests: XCTestCase {
    private func workspaces(_ json: String) throws -> [OS1API.WorkspaceSummary] {
        struct Response: Decodable {
            let workspaces: [OS1API.WorkspaceSummary]
        }
        return try JSONDecoder().decode(Response.self, from: Data(json.utf8)).workspaces
    }

    private func sessions(_ json: String) throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(json.utf8))
    }

    func testWorkspaceListDecodesParkedPromptMetadata() throws {
        let workspace = try XCTUnwrap(workspaces(
            #"{"workspaces":[{"id":"ws-draft","name":"Investigate uploads","repo":"tella-fusion","createdBy":"Michiel","createdAt":"2026-08-17T09:00:00Z","draft":{"text":"Investigate uploads","updatedAt":"2026-08-17T10:00:00Z","by":"Michiel","autoName":true}}]}"#
        ).first)

        XCTAssertEqual(workspace.repo, "tella-fusion")
        XCTAssertEqual(workspace.createdBy, "Michiel")
        XCTAssertEqual(workspace.draft?.text, "Investigate uploads")
        XCTAssertEqual(workspace.draft?.autoName, true)
    }

    func testFreshDraftNameUsesFirstNonEmptyLine() {
        XCTAssertEqual(
            OS1API.WorkspaceDraft.workspaceName(for: "\n  Investigate uploads  \nMore detail"),
            "Investigate uploads"
        )
    }

    func testOnlySessionlessDraftWorkspacesGainRows() throws {
        let workspaceList = try workspaces(
            #"{"workspaces":[{"id":"ws-draft","name":"Parked work","repo":"opensession","createdBy":"Michiel","createdAt":"2026-08-17T09:00:00Z","draft":{"text":"Parked work","updatedAt":"2026-08-17T10:00:00Z"}},{"id":"ws-empty","name":"Empty","createdBy":"Michiel","createdAt":"2026-08-17T08:00:00Z"},{"id":"ws-occupied","name":"Occupied","createdBy":"Michiel","createdAt":"2026-08-17T07:00:00Z","draft":{"text":"Stale","updatedAt":"2026-08-17T07:30:00Z"}}]}"#
        )
        let sessionList = try sessions(
            #"[{"id":"active","workspaceId":"ws-occupied","title":"Active session"}]"#
        )

        let rows = SessionsListViewModel.sidebarWorkspaces(
            in: sessionList,
            workspaceNames: ["ws-occupied": "Occupied"],
            workspaces: workspaceList
        )

        XCTAssertEqual(
            Set(rows.map(\.id)),
            Set(["workspace:ws-occupied", "workspace:ws-draft"])
        )
        let draft = try XCTUnwrap(rows.first { $0.id == "workspace:ws-draft" })
        XCTAssertTrue(draft.isDraftWorkspace)
        XCTAssertTrue(draft.sessions.isEmpty)
        XCTAssertEqual(draft.mainSession.id, "workspace-draft:ws-draft")
        XCTAssertEqual(draft.lastActivityDate, Session.parseISO("2026-08-17T10:00:00Z"))
    }

    func testFilteredWorkerStillOccupiesItsDraftWorkspace() throws {
        let workspace = try XCTUnwrap(workspaces(
            #"{"workspaces":[{"id":"ws-worker","name":"Worker","createdBy":"Michiel","createdAt":"2026-08-17T09:00:00Z","draft":{"text":"Do not duplicate","updatedAt":"2026-08-17T10:00:00Z"}}]}"#
        ).first)
        let all = try sessions(
            #"[{"id":"worker","workspaceId":"ws-worker","spawnedBy":"parent"}]"#
        )
        let listed = SessionsListViewModel.listedSessions(in: all, claimed: [])

        let rows = SessionsListViewModel.sidebarWorkspaces(
            in: listed,
            workspaces: [workspace],
            occupiedWorkspaceIds: Set(all.compactMap(\.workspaceId))
        )

        XCTAssertTrue(listed.isEmpty)
        XCTAssertTrue(rows.isEmpty)
    }

    func testDraftCreatorOwnsSessionlessRowOnly() throws {
        let workspace = try XCTUnwrap(workspaces(
            #"{"workspaces":[{"id":"ws-draft","name":"Parked work","createdBy":"Michiel","createdAt":"2026-08-17T09:00:00Z","draft":{"text":"Parked work","updatedAt":"2026-08-17T10:00:00Z"}}]}"#
        ).first)
        let row = try XCTUnwrap(SessionsListViewModel.sidebarWorkspaces(
            in: [], workspaces: [workspace]
        ).first)

        XCTAssertTrue(PeopleLens(names: ["michiel"], claims: []).owns(row))
        XCTAssertFalse(PeopleLens(names: ["kent"], claims: []).owns(row))
    }
}
