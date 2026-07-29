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
}
