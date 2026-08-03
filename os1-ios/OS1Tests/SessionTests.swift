import XCTest
@testable import OS1

final class SessionTests: XCTestCase {
    func testMissingRepoUsesServerDefault() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"bks-1"}"#.utf8)
        )

        XCTAssertNil(session.repo)
        XCTAssertEqual(session.effectiveRepo, "opensession")
    }

    func testExplicitRepoIsPreserved() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"bks-1","repo":"backstage"}"#.utf8)
        )

        XCTAssertEqual(session.effectiveRepo, "backstage")
    }

    func testRepositoryOrderUsesFrequencyThenName() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"1","repo":"zebra"},{"id":"2","repo":"alpha"},{"id":"3","repo":"zebra"},{"id":"4","repo":"beta"},{"id":"5","repo":"alpha"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.repositoryOrder(in: sessions),
            ["alpha", "zebra", "beta"]
        )
    }

    func testRepositoryOrderHonorsPreferenceAndAppendsNewRepos() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"1","repo":"alpha"},{"id":"2","repo":"beta"},{"id":"3","repo":"gamma"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.repositoryOrder(
                in: sessions,
                preferredOrderJSON: #"["gamma","missing","alpha","gamma"]"#
            ),
            ["gamma", "alpha", "beta"]
        )
    }

    func testTabSessionsUseWorkspaceAndNaturalOrder() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"second","projectId":"prj-1","createdAt":"2026-07-02T00:00:00Z"},{"id":"other","projectId":"prj-2","createdAt":"2026-07-01T00:00:00Z"},{"id":"first","projectId":"prj-1","createdAt":"2026-07-01T00:00:00Z"},{"id":"archived","projectId":"prj-1","archived":true},{"id":"side","projectId":"prj-1","sideChatOf":"first"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[0]).map(\.id),
            ["first", "second"]
        )
    }

    func testTabSessionsFallBackToIsolatedWorktree() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"one","worktreeDir":"/home/ubuntu/worktrees/feature"},{"id":"two","worktreeDir":"/home/ubuntu/worktrees/feature"},{"id":"main","worktreeDir":"/home/ubuntu/projects/tella-backstage"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[0]).map(\.id),
            ["one", "two"]
        )
        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[2]).map(\.id),
            ["main"]
        )
    }

    func testWorktreeFallbackIncludesWorkspaceAssignedSibling() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"readonly","worktreeDir":"/home/ubuntu/worktrees/feature"},{"id":"filed","projectId":"prj-1","worktreeDir":"/home/ubuntu/worktrees/feature"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[0]).map(\.id),
            ["filed", "readonly"]
        )
        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[1]).map(\.id),
            ["filed", "readonly"]
        )
    }

    func testSidebarCollapsesWorkspaceSessionsIntoOneRow() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","projectId":"prj-1","branch":"feature","createdAt":"2026-07-01T00:00:00Z","lastActivity":"2026-07-01T00:01:00Z","opencodeSessionId":"oc-1"},{"id":"second","projectId":"prj-1","branch":"feature","createdAt":"2026-07-02T00:00:00Z","lastActivity":"2026-07-02T00:01:00Z"},{"id":"other","projectId":"prj-2","branch":"other"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(
            in: sessions,
            workspaceNames: ["prj-1": "Feature workspace"]
        )

        XCTAssertEqual(workspaces.count, 2)
        XCTAssertEqual(workspaces[0].title, "Feature workspace")
        XCTAssertEqual(workspaces[0].sessions.map(\.id), ["first", "second"])
        XCTAssertEqual(workspaces[0].mainSession.id, "first")
    }

    func testSidebarDoesNotMergeDistinctWorkspacesSharingAPath() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","projectId":"prj-1","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"},{"id":"second","projectId":"prj-2","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"},{"id":"main-one","projectId":"prj-3","worktreeDir":"/home/ubuntu/projects/tella-backstage"},{"id":"main-two","projectId":"prj-4","worktreeDir":"/home/ubuntu/projects/tella-backstage"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.count, 4)
        XCTAssertEqual(workspaces.map(\.sessions).map { $0.map(\.id) }, [
            ["first"], ["second"], ["main-one"], ["main-two"]
        ])
    }

    func testSidebarAdoptsProjectlessSiblingUsingTheSameWorktree() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"filed","projectId":"prj-1","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"},{"id":"legacy","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0].sessions.map(\.id), ["filed", "legacy"])
    }

    func testSidebarManualRenameWinsOverFallbackBranch() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","worktreeDir":"/home/ubuntu/worktrees/feature","branch":"feature"},{"id":"renamed","worktreeDir":"/home/ubuntu/worktrees/feature","branch":"feature","title":"Customer escalation","titleOverridden":true}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.first?.title, "Customer escalation")
    }

    func testOptimisticSessionStaysMarkedAfterReceivingRealId() {
        let session = Session.optimistic(
            id: "bks-real",
            title: "New chat",
            repo: "backstage",
            mode: "code",
            model: nil,
            effort: nil,
            fastMode: false,
            startedBy: "Alice"
        )

        XCTAssertTrue(session.isOptimisticPlaceholder == true)
    }

    func testTabSessionsPinStartedHumanChatFirst() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"automation","projectId":"prj-1","automation":"Review","createdAt":"2026-07-01T00:00:00Z","lastActivity":"2026-07-01T00:01:00Z","opencodeSessionId":"oc-1"},{"id":"main","projectId":"prj-1","createdAt":"2026-07-02T00:00:00Z","lastActivity":"2026-07-02T00:01:00Z","opencodeSessionId":"oc-2"},{"id":"shell","projectId":"prj-1","createdAt":"2026-07-03T00:00:00Z","lastActivity":"2026-07-03T00:00:00Z"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[1]).map(\.id),
            ["main", "automation", "shell"]
        )
    }

    func testTabSessionsUseLatestPolledWorkspaceMembership() throws {
        let stale = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"current"}"#.utf8)
        )
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"current","projectId":"prj-1","createdAt":"2026-07-01T00:00:00Z"},{"id":"sibling","projectId":"prj-1","createdAt":"2026-07-02T00:00:00Z"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: stale).map(\.id),
            ["current", "sibling"]
        )
    }

    func testEmptyEngineIdStillCountsAsNeverRun() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(
                #"{"id":"shell","claudeSessionId":"","createdAt":"2026-07-01T00:00:00Z","lastActivity":"2026-07-01T00:00:00Z"}"#.utf8
            )
        )

        XCTAssertTrue(session.neverRan)
    }
}
