import XCTest
@testable import OS1

final class CommitDetailsTests: XCTestCase {
    func testDecodesTheCurrentLookupResponse() throws {
        let details = try JSONDecoder().decode(CommitDetails.self, from: Data("""
        {
          "repo":"opensession",
          "sha":"4ed1ef09aa11bb22cc33dd44ee55ff6600778899",
          "shortSha":"4ed1ef09",
          "title":"Fix transcript references",
          "body":"Keep the parser conservative.",
          "author":"Michael Robot",
          "person":null,
          "committedAt":"2026-08-17T10:20:30Z",
          "filesChanged":3,
          "additions":42,
          "deletions":7,
          "url":"https://github.com/tellahq/opensession/commit/4ed1ef09aa11bb22cc33dd44ee55ff6600778899",
          "onDefaultBranch":true,
          "defaultBranch":"main"
        }
        """.utf8))
        XCTAssertEqual(details.repo, "opensession")
        XCTAssertEqual(details.shortSha, "4ed1ef09")
        XCTAssertEqual(details.filesChanged, 3)
        XCTAssertTrue(details.onDefaultBranch)
        XCTAssertNotNil(details.committedDate)
    }

    func testLookupPathCarriesTheRepoHint() throws {
        let path = CommitDetails.lookupPath(sha: "4ed1ef09", repo: "open session/test")
        let components = try XCTUnwrap(URLComponents(string: path))
        XCTAssertEqual(components.path, "/api/commit")
        XCTAssertEqual(components.queryItems?.first { $0.name == "sha" }?.value, "4ed1ef09")
        XCTAssertEqual(
            components.queryItems?.first { $0.name == "repo" }?.value,
            "open session/test"
        )
    }
}
