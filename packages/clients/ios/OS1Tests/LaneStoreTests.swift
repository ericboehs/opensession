import XCTest
@testable import OS1

@MainActor
final class LaneStoreTests: XCTestCase {
    private enum TestError: Error { case failed }

    private func sessions(_ json: String) throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(json.utf8))
    }

    private let lens = PeopleLens(names: ["kent"], claims: [])

    func testTeammateAutomationAndAgentStartedSessionsCanBeAdded() throws {
        let candidates = try sessions(
            #"[{"id":"os-teammate","startedBy":"Jaap"},{"id":"os-automation","automation":"triage","startedBy":"Kent (automation)"},{"id":"os-agent","agentStarted":true,"startedBy":"Automation"},{"id":"os-spawned","startedBy":"Kent","spawnedBy":"os-parent"}]"#
        )

        for session in candidates {
            XCTAssertTrue(LaneStore.canAddToSidebar(
                session: session,
                workspaceSessions: [session],
                lens: lens,
                claims: []
            ))
        }
    }

    func testNaturallyOwnedWorkspaceDoesNotOfferRedundantAdd() throws {
        let workspace = try sessions(
            #"[{"id":"os-teammate","workspaceId":"ws-1","startedBy":"Jaap"},{"id":"os-mine","workspaceId":"ws-1","startedBy":"Kent"}]"#
        )

        XCTAssertFalse(LaneStore.canAddToSidebar(
            session: workspace[0],
            workspaceSessions: workspace,
            lens: lens,
            claims: []
        ))
    }

    func testClaimedAndArchivedSessionsCannotBeAdded() throws {
        let session = try sessions(#"[{"id":"os-1","startedBy":"Jaap"}]"#)[0]
        var archived = session
        archived.archived = true

        XCTAssertFalse(LaneStore.canAddToSidebar(
            session: session,
            workspaceSessions: [session],
            lens: lens,
            claims: [session.id]
        ))
        XCTAssertFalse(LaneStore.canAddToSidebar(
            session: archived,
            workspaceSessions: [archived],
            lens: lens,
            claims: []
        ))
    }

    func testClaimOptimisticallyWritesEveryWorkspaceSessionAsMine() async throws {
        let wrote = expectation(description: "lane delta written")
        var writtenUser = ""
        var writtenSet: [String: String] = [:]
        var writtenRemove: [String] = []
        let store = LaneStore(writer: { user, set, remove, _ in
            writtenUser = user
            writtenSet = set
            writtenRemove = remove
            wrote.fulfill()
            return set
        })
        store.applyHydrated([:])
        let workspace = try sessions(
            #"[{"id":"os-1","workspaceId":"ws-1"},{"id":"os-2","workspaceId":"ws-1"}]"#
        )

        store.claim(workspace)

        XCTAssertEqual(store.claims, ["os-1", "os-2"])
        await fulfillment(of: [wrote])
        XCTAssertEqual(writtenUser, ServerConfig.shared.userName)
        XCTAssertEqual(writtenSet, ["os-1": "mine", "os-2": "mine"])
        XCTAssertTrue(writtenRemove.isEmpty)
    }

    func testFailedWriteKeepsTheClaimPendingAndHydrationRetriesIt() async throws {
        let firstAttempt = expectation(description: "first lane delta attempted")
        let retry = expectation(description: "pending lane delta retried")
        var attempts = 0
        let store = LaneStore(writer: { _, set, _, _ in
            attempts += 1
            if attempts == 1 {
                firstAttempt.fulfill()
                throw TestError.failed
            }
            retry.fulfill()
            return ["os-existing": "review"].merging(set) { _, claimed in claimed }
        })
        store.applyHydrated(["os-existing": "review"])
        let session = try sessions(#"[{"id":"os-new"}]"#)[0]

        store.claim([session])
        await fulfillment(of: [firstAttempt])
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(store.claims, ["os-existing", "os-new"])

        store.applyHydrated(["os-existing": "review"])
        await fulfillment(of: [retry])
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(store.claims, ["os-existing", "os-new"])
    }

    func testHydrationStartedBeforeConfirmedClaimCannotOverwriteIt() async throws {
        let readStarted = expectation(description: "lane hydration started")
        let writeCompleted = expectation(description: "lane write completed")
        var finishRead: CheckedContinuation<[String: String], Never>?
        let store = LaneStore(
            reader: { _ in
                readStarted.fulfill()
                return await withCheckedContinuation { finishRead = $0 }
            },
            writer: { _, set, _, _ in
                writeCompleted.fulfill()
                return set
            }
        )
        store.applyHydrated([:])
        let session = try sessions(#"[{"id":"os-new"}]"#)[0]

        let hydration = Task { await store.hydrate() }
        await fulfillment(of: [readStarted])
        store.claim([session])
        await fulfillment(of: [writeCompleted])
        for _ in 0..<5 { await Task.yield() }

        finishRead?.resume(returning: [:])
        await hydration.value
        XCTAssertEqual(store.claims, ["os-new"])
    }

    func testCompletedWriteCannotRepopulateClaimsAfterAccountChange() async throws {
        let started = expectation(description: "write started")
        let completed = expectation(description: "write completed")
        var resume: CheckedContinuation<Void, Never>?
        let store = LaneStore(writer: { _, set, _, _ in
            started.fulfill()
            await withCheckedContinuation { resume = $0 }
            completed.fulfill()
            return set
        })
        store.applyHydrated([:])
        let session = try sessions(#"[{"id":"os-new"}]"#)[0]
        let config = ServerConfig.shared
        let originalUser = config.userName
        defer { config.userName = originalUser }

        store.claim([session])
        await fulfillment(of: [started])
        config.userName = originalUser + " other"
        store.syncContext()
        XCTAssertTrue(store.claims.isEmpty)

        resume?.resume()
        await fulfillment(of: [completed])
        for _ in 0..<5 { await Task.yield() }
        XCTAssertTrue(store.claims.isEmpty)
    }
}
