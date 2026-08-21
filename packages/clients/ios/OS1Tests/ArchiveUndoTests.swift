import XCTest
@testable import OS1

@MainActor
final class ArchiveUndoTests: XCTestCase {
    private func sessions(_ json: String) throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(json.utf8))
    }

    private func model(now: @escaping () -> Date) -> SessionsListViewModel {
        SessionsListViewModel(
            now: now,
            archiveUndoLifetime: 7,
            setArchived: { _, _ in },
            reconcilesArchiveMutations: false
        )
    }

    func testUndoRestoresTheSnapshotOwnedByItsArchiveAction() throws {
        let now = Date(timeIntervalSince1970: 100)
        let model = model(now: { now })
        let rows = try sessions(
            #"[{"id":"workspace-a"},{"id":"workspace-b"},{"id":"later"}]"#
        )

        model.archive(Array(rows.prefix(2)))
        let firstOffer = try XCTUnwrap(model.archiveUndoOffers.first)
        model.archive(rows[2])
        let laterOffer = try XCTUnwrap(model.archiveUndoOffers.last)

        XCTAssertTrue(model.undoArchive(firstOffer.id))
        XCTAssertEqual(Set(model.sessions.map(\.id)), ["workspace-a", "workspace-b"])
        XCTAssertEqual(model.archiveUndoOffers.map(\.id), [laterOffer.id])
        XCTAssertFalse(model.sessions.contains(where: { $0.id == "later" }))
    }

    func testExpiredAndRepeatedArchiveOffersStayIndependent() throws {
        var now = Date(timeIntervalSince1970: 200)
        let model = model(now: { now })
        let rows = try sessions(#"[{"id":"first"},{"id":"second"}]"#)

        model.archive(rows[0])
        let firstOffer = try XCTUnwrap(model.archiveUndoOffers.first)
        now = now.addingTimeInterval(4)
        model.archive(rows[1])
        let secondOffer = try XCTUnwrap(model.archiveUndoOffers.last)

        XCTAssertNotEqual(firstOffer.id, secondOffer.id)
        now = now.addingTimeInterval(4)
        model.expireArchiveUndos(at: now)
        XCTAssertEqual(model.archiveUndoOffers.map(\.id), [secondOffer.id])
        XCTAssertFalse(model.undoArchive(firstOffer.id))
        XCTAssertTrue(model.undoArchive(secondOffer.id))
        XCTAssertEqual(model.sessions.map(\.id), ["second"])
    }
}
