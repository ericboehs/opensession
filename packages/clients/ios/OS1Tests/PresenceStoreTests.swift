import XCTest
@testable import OS1

@MainActor
final class PresenceStoreTests: XCTestCase {
    override func tearDown() async throws {
        PresenceStore.shared.stop()
    }

    private func entry(_ user: String, _ sessionId: String) -> PresenceEntry {
        PresenceEntry(user: user, sessionId: sessionId)
    }

    func testRowViewersSpanWorkspaceAndDeduplicate() {
        let store = PresenceStore.shared
        store.apply([
            entry("Zzz Tester", "os-1"),
            entry("Qqq Tester", "os-2"),
            entry("Zzz Tester", "os-2"),
        ])

        XCTAssertEqual(
            store.viewers(of: [Session(id: "os-1"), Session(id: "os-2")]),
            ["Zzz Tester", "Qqq Tester"]
        )
        XCTAssertEqual(store.viewers(of: [Session(id: "os-2")]), ["Qqq Tester", "Zzz Tester"])
        XCTAssertTrue(store.viewers(of: [Session(id: "os-3")]).isEmpty)
    }

    func testOwnPresenceIsFilteredOut() {
        let store = PresenceStore.shared
        store.apply([
            entry(ServerConfig.shared.userName, "os-1"),
            entry("Zzz Tester", "os-1"),
        ])

        XCTAssertEqual(store.viewers(of: [Session(id: "os-1")]), ["Zzz Tester"])
    }

    func testSuspendPreservesPresenceSnapshot() {
        let store = PresenceStore.shared
        store.apply([entry("Zzz Tester", "os-1")])

        store.suspend()

        XCTAssertEqual(store.viewers(of: [Session(id: "os-1")]), ["Zzz Tester"])
    }

    func testStopClearsStaleViewers() {
        let store = PresenceStore.shared
        store.apply([entry("Zzz Tester", "os-1")])
        XCTAssertFalse(store.viewers(of: [Session(id: "os-1")]).isEmpty)

        store.stop()
        XCTAssertTrue(store.viewers(of: [Session(id: "os-1")]).isEmpty)
    }
}
