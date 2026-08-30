import XCTest
@testable import OS1

final class SidebarAdditionTests: XCTestCase {
    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private func intent(
        _ session: Session,
        siblings: [Session]? = nil,
        claims: Set<String> = [],
        hidden: Bool = false
    ) -> SidebarAddition.Intent? {
        SidebarAddition.intent(
            for: session,
            siblings: siblings ?? [session],
            claims: claims,
            hidden: hidden,
            viewerName: "Kent de Bruin",
            viewerLogin: "kentdebruin"
        )
    }

    func testOffersClaimForTeammateAutomationAndSpawnedSessions() throws {
        let teammate = try session(#"{"id":"team","startedBy":"Michiel"}"#)
        let automation = try session(#"{"id":"auto","startedBy":"Automation","automation":"triage"}"#)
        let spawned = try session(#"{"id":"spawned","startedBy":"Kent","spawnedBy":"parent"}"#)

        XCTAssertEqual(intent(teammate), .claim)
        XCTAssertEqual(intent(automation), .claim)
        XCTAssertEqual(intent(spawned), .claim)
    }

    func testDoesNotOfferForOwnOrdinarySessionOrItsWorkspace() throws {
        let teammate = try session(#"{"id":"team","workspaceId":"ws","startedBy":"Michiel"}"#)
        let mine = try session(#"{"id":"mine","workspaceId":"ws","startedBy":"Kent"}"#)

        XCTAssertNil(intent(mine))
        XCTAssertNil(intent(teammate, siblings: [teammate, mine]))
    }

    func testDoesNotOfferForClaimedOrArchivedSession() throws {
        let teammate = try session(#"{"id":"team","startedBy":"Michiel"}"#)
        let archived = try session(#"{"id":"old","startedBy":"Michiel","archived":true}"#)

        XCTAssertNil(intent(teammate, claims: ["team"]))
        XCTAssertNil(intent(archived))
    }

    func testHiddenRowCanBeRestoredEvenWhenAlreadyClaimedOrNatural() throws {
        let teammate = try session(#"{"id":"team","startedBy":"Michiel"}"#)
        let mine = try session(#"{"id":"mine","startedBy":"Kent"}"#)

        XCTAssertEqual(intent(teammate, claims: ["team"], hidden: true), .restore)
        XCTAssertEqual(intent(mine, hidden: true), .restore)
    }
}

@MainActor
final class LaneStoreWriteTests: XCTestCase {
    func testPreHydrationClaimIsReplayedOverRemoteState() {
        let store = LaneStore()
        store.claim([Session(id: "local")])

        store.applyHydrated(["remote": "review"], persist: false)

        XCTAssertEqual(store.claims, ["local", "remote"])
    }

    func testWriteResponseAcknowledgesOnlyCapturedChanges() {
        let store = LaneStore()
        store.claim([Session(id: "first"), Session(id: "later")])
        store.applyHydrated([:], persist: false)

        store.applySaved(
            ["first": "mine", "remote": "pending"],
            acknowledging: ["first": "mine"]
        )

        XCTAssertEqual(store.claims, ["first", "later", "remote"])
    }

    func testFailedWriteKeepsClaimPendingAndHydrationRetriesIt() async {
        enum TestError: Error { case failed }
        let firstAttempt = expectation(description: "first lane delta attempted")
        let retry = expectation(description: "pending lane delta retried")
        var attempts = 0
        let store = LaneStore(writer: { _, set, _ in
            attempts += 1
            if attempts == 1 {
                firstAttempt.fulfill()
                throw TestError.failed
            }
            retry.fulfill()
            return set
        })
        store.applyHydrated([:])

        store.claim([Session(id: "local")])
        await fulfillment(of: [firstAttempt])
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(store.claims, ["local"])

        store.applyHydrated([:])
        await fulfillment(of: [retry])
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(store.claims, ["local"])
    }

    func testHydrationStartedBeforeConfirmedClaimCannotOverwriteIt() async {
        let readStarted = expectation(description: "lane hydration started")
        let writeCompleted = expectation(description: "lane write completed")
        var finishRead: CheckedContinuation<[String: String], Never>?
        let store = LaneStore(
            reader: { _ in
                readStarted.fulfill()
                return await withCheckedContinuation { finishRead = $0 }
            },
            writer: { _, set, _ in
                writeCompleted.fulfill()
                return set
            }
        )
        store.applyHydrated([:])

        let hydration = Task { await store.hydrate() }
        await fulfillment(of: [readStarted])
        store.claim([Session(id: "local")])
        await fulfillment(of: [writeCompleted])
        for _ in 0..<5 { await Task.yield() }

        finishRead?.resume(returning: [:])
        await hydration.value
        XCTAssertEqual(store.claims, ["local"])
    }

    func testCompletedWriteCannotRepopulateClaimsAfterAccountChange() async {
        let started = expectation(description: "write started")
        let completed = expectation(description: "write completed")
        var resume: CheckedContinuation<Void, Never>?
        let store = LaneStore(writer: { _, set, _ in
            started.fulfill()
            await withCheckedContinuation { resume = $0 }
            completed.fulfill()
            return set
        })
        store.applyHydrated([:])
        let config = ServerConfig.shared
        let originalUser = config.userName
        defer { config.userName = originalUser }

        store.claim([Session(id: "local")])
        await fulfillment(of: [started])
        config.userName = originalUser + " other"
        store.claim([])
        XCTAssertTrue(store.claims.isEmpty)

        resume?.resume()
        await fulfillment(of: [completed])
        for _ in 0..<5 { await Task.yield() }
        XCTAssertTrue(store.claims.isEmpty)
    }
}
