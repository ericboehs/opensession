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
}
