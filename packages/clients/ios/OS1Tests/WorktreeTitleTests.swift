import XCTest
@testable import OS1

/// The session bar names the worktree, not the chat open inside it
/// (`SessionsListViewModel.worktreeTitle`). What matters is that it agrees
/// with the sidebar for every shape of row, and that the one place the
/// sidebar's rule is unusable — a solo chat, whose row falls back to its
/// branch — keeps the conversation's own title instead of saying "main".
final class WorktreeTitleTests: XCTestCase {
    private func sessions(_ json: String) throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(json.utf8))
    }

    private func title(
        of id: String, in tabs: [Session], names: [String: String] = [:]
    ) throws -> String {
        let session = try XCTUnwrap(tabs.first { $0.id == id })
        return SessionsListViewModel.worktreeTitle(
            for: session, in: tabs, workspaceNames: names
        )
    }

    /// Every chat of a workspace answers with the workspace's name, not its
    /// own — that IS the change: opening the second tab used to rename the bar.
    func testEveryChatOfANamedWorkspaceReadsTheWorkspaceName() throws {
        let tabs = try sessions(
            """
            [{"id":"os-1","title":"Fix the fold","workspaceId":"ws-1",
              "worktreeDir":"/home/u/worktrees/one"},
             {"id":"os-2","title":"Review round 2","workspaceId":"ws-1",
              "worktreeDir":"/home/u/worktrees/one"}]
            """
        )
        let names = ["ws-1": "Walkthrough sizing"]

        XCTAssertEqual(try title(of: "os-1", in: tabs, names: names), "Walkthrough sizing")
        XCTAssertEqual(try title(of: "os-2", in: tabs, names: names), "Walkthrough sizing")
    }

    /// Unnamed, the workspace is known by the conversation that started it —
    /// so a later tab still reads the first chat's title, never its own.
    func testUnnamedWorkspaceFallsBackToItsFirstConversation() throws {
        let tabs = try sessions(
            """
            [{"id":"os-1","title":"Fix the fold","workspaceId":"ws-1",
              "createdAt":"2026-08-10T10:00:00.000Z"},
             {"id":"os-2","title":"Review round 2","workspaceId":"ws-1",
              "createdAt":"2026-08-10T11:00:00.000Z"}]
            """
        )

        XCTAssertEqual(try title(of: "os-2", in: tabs), "Fix the fold")
    }

    /// A legacy workspace-less worktree row is known by its branch, which is
    /// the only name that row has. The bar says what the sidebar says.
    func testLegacyWorktreeRowReadsItsBranch() throws {
        let tabs = try sessions(
            """
            [{"id":"os-9","title":"Trim tool reset","branch":"trim-tool-reset",
              "worktreeDir":"/home/u/worktrees/trim-tool-reset"}]
            """
        )

        XCTAssertEqual(try title(of: "os-9", in: tabs), "trim-tool-reset")
    }

    /// The exception. A solo chat in a shared checkout has no worktree above
    /// it; its sidebar row would be titled by the branch, and a bar reading
    /// "main" on every such session names nothing at all.
    func testSoloSessionKeepsItsOwnTitle() throws {
        let tabs = try sessions(
            """
            [{"id":"os-7","title":"Increase iOS walkthrough size","branch":"main"}]
            """
        )

        XCTAssertEqual(try title(of: "os-7", in: tabs), "Increase iOS walkthrough size")
    }

    /// A session opened without its siblings (a push straight from a link or
    /// a notification) still has to render a bar.
    func testMissingTabsFallBackToTheSessionsOwnTitle() throws {
        let tabs = try sessions(
            """
            [{"id":"os-1","title":"Fix the fold","workspaceId":"ws-1",
              "worktreeDir":"/home/u/worktrees/one"}]
            """
        )
        let session = try XCTUnwrap(tabs.first)

        XCTAssertEqual(
            SessionsListViewModel.worktreeTitle(
                for: session, in: [], workspaceNames: ["ws-1": "Walkthrough sizing"]
            ),
            "Fix the fold"
        )
    }
}
