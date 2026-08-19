import XCTest
@testable import OS1

/// The three list rules this app shares with the web sidebar: which spawned
/// workers earn a row, what grouping an unconfigured list starts on, and who
/// the Archived screen's Owner lens offers.
final class SessionsListLensTests: XCTestCase {
    private func sessions(_ json: String) throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(json.utf8))
    }

    // MARK: - Spawned workers

    func testSpawnedWorkerStaysOutOfTheListUntilItNeedsSomeone() throws {
        let all = try sessions(
            """
            [{"id":"os-plain"},
             {"id":"os-worker","spawnedBy":"os-plain"},
             {"id":"os-blocked","spawnedBy":"os-plain","waitingForInput":true},
             {"id":"os-claimed","spawnedBy":"os-plain"}]
            """
        )

        XCTAssertEqual(
            SessionsListViewModel.listedSessions(in: all, claimed: []).map(\.id),
            ["os-plain", "os-blocked"]
        )
        // Claiming one is the other way in — the same per-user triage that
        // pulls an automation's run into your list.
        XCTAssertEqual(
            SessionsListViewModel.listedSessions(in: all, claimed: ["os-claimed"]).map(\.id),
            ["os-plain", "os-blocked", "os-claimed"]
        )
    }

    func testAWorkerGetsNoRowButKeepsItsSession() throws {
        // The rule is applied while BUILDING rows, so a `@session:` link in a
        // transcript can still open the worker the run spawned.
        let all = try sessions(
            """
            [{"id":"os-parent","workspaceId":"ws-1"},
             {"id":"os-worker","workspaceId":"ws-2","spawnedBy":"os-parent"}]
            """
        )
        let prepared = SessionsListViewModel.prepared(all, hiding: [], restoring: [])

        XCTAssertEqual(prepared.active.map(\.id).sorted(), ["os-parent", "os-worker"])
        let rows = SessionsListViewModel.sidebarWorkspaces(
            in: SessionsListViewModel.listedSessions(in: prepared.active, claimed: [])
        )
        XCTAssertEqual(rows.map(\.id), ["workspace:ws-1"])
    }

    // MARK: - Default grouping

    func testOneProjectDefaultsToTheInbox() {
        XCTAssertEqual(SessionsListView.defaultGroupBy(repoCount: 1), .inbox)
        XCTAssertEqual(SessionsListView.defaultGroupBy(repoCount: 4), .repoStatus)
        // Unknown until `/api/repos` answers: assume several, so an instance
        // that has them doesn't paint a flat list and re-band a moment later.
        XCTAssertEqual(
            SessionsListView.defaultGroupBy(repoCount: RepoCount.unknown), .repoStatus
        )
    }

    // MARK: - Archived owners

    private let roster = ["kent": "Kent", "michiel": "Michiel"]

    func testOwnerOptionsMergeBothSpellingsOfOnePerson() throws {
        let archive = try sessions(
            """
            [{"id":"a","startedBy":"Kent"},
             {"id":"b","startedBy":"Kent de Bruin"},
             {"id":"c","startedBy":"Michiel"},
             {"id":"d","startedBy":"worker os-019fe"},
             {"id":"e","startedBy":"Kent","automation":"nightly-triage"}]
            """
        )

        let owners = ArchivedOwners.options(in: archive, roster: roster, excluding: "")
        // One option per person, busiest first — never one per spelling, and
        // never the session ids the archive is otherwise full of.
        XCTAssertEqual(owners.map(\.label), ["Kent", "Michiel"])
        XCTAssertEqual(owners.map(\.key), ["kent", "michiel"])

        // Both spellings answer to the same option; an automation's run is
        // nobody's, however it was signed.
        XCTAssertTrue(ArchivedOwners.session(archive[0], hasOwner: "kent", roster: roster))
        XCTAssertTrue(ArchivedOwners.session(archive[1], hasOwner: "kent", roster: roster))
        XCTAssertFalse(ArchivedOwners.session(archive[4], hasOwner: "kent", roster: roster))
    }

    func testTheSignedInPersonIsNotOfferedAsATeammate() throws {
        let archive = try sessions(
            """
            [{"id":"a","startedBy":"Kent de Bruin"},{"id":"b","startedBy":"Michiel"}]
            """
        )

        XCTAssertEqual(
            ArchivedOwners.options(in: archive, roster: roster, excluding: "kent").map(\.label),
            ["Michiel"]
        )
    }

    func testSomeoneOutsideTheRosterStillFiltersUnderTheirRawName() throws {
        let archive = try sessions(#"[{"id":"a","startedBy":"Ada"}]"#)

        XCTAssertEqual(ArchivedOwners.ownerKey(of: archive[0], roster: roster), "ada")
        XCTAssertTrue(ArchivedOwners.session(archive[0], hasOwner: "ada", roster: roster))
        // …but is not offered as an option: an unfiltered list is mostly
        // spawned workers and integration senders.
        XCTAssertTrue(ArchivedOwners.options(in: archive, roster: roster, excluding: "").isEmpty)
    }
}
