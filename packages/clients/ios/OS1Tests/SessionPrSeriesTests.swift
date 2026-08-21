import XCTest
@testable import OS1

@MainActor
final class SessionPrSeriesTests: XCTestCase {
    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    func testPrimaryComesBeforeAdditionalPullRequestsWithoutReorderingTheRest() throws {
        let value = try session(
            """
            {
              "id":"os-series",
              "repo":"opensession",
              "branch":"stack/foundation",
              "prs":[
                {"repo":"tella-mac","branch":"stack/desktop","source":"attached","number":73,"title":"Desktop shell","state":"OPEN","url":"https://github.com/tellahq/tella-mac/pull/73"},
                {"repo":"opensession","branch":"stack/follow-up","source":"linked","number":74,"title":"Follow-up","state":"MERGED","url":"https://github.com/tellahq/opensession/pull/74"},
                {"repo":"opensession","branch":"stack/foundation","source":"primary","number":72,"title":"Foundation","state":"OPEN","url":"https://github.com/tellahq/opensession/pull/72"}
              ]
            }
            """
        )

        let rows = SessionPrSeries.rows(for: value)

        XCTAssertEqual(rows.map(\.number), [72, 73, 74])
        XCTAssertEqual(rows.map(\.title), ["Foundation", "Desktop shell", "Follow-up"])
        XCTAssertEqual(rows.map(\.state), ["Open", "Open", "Merged"])
        XCTAssertEqual(rows.map(\.isPrimary), [true, false, false])
    }

    func testEachAdditionalRowKeepsItsOwnRepoBranchAndUrlTarget() throws {
        let value = try session(
            """
            {
              "id":"os-targets",
              "repo":"opensession",
              "branch":"stack/foundation",
              "prs":[
                {"repo":"opensession","branch":"stack/foundation","source":"primary","number":72,"state":"OPEN","url":"https://github.com/tellahq/opensession/pull/72"},
                {"repo":"tella-mac","branch":"stack/desktop","source":"attached","number":73,"state":"OPEN","url":"https://github.com/tellahq/tella-mac/pull/73"},
                {"repo":"opensession","branch":"stack/follow-up","source":"linked","number":74,"state":"MERGED","url":"https://github.com/tellahq/opensession/pull/74"}
              ]
            }
            """
        )

        let rows = SessionPrSeries.rows(for: value)

        XCTAssertEqual(
            rows.map(\.target),
            [
                SessionPrTarget(repo: "opensession", branch: "stack/foundation"),
                SessionPrTarget(repo: "tella-mac", branch: "stack/desktop"),
                SessionPrTarget(repo: "opensession", branch: "stack/follow-up"),
            ]
        )
        XCTAssertEqual(
            rows.map(\.url?.absoluteString),
            [
                "https://github.com/tellahq/opensession/pull/72",
                "https://github.com/tellahq/tella-mac/pull/73",
                "https://github.com/tellahq/opensession/pull/74",
            ]
        )
    }

    func testLegacyPrimaryPrecedesProjectedAdditionalPullRequests() throws {
        let value = try session(
            """
            {
              "id":"os-legacy",
              "repo":"opensession",
              "branch":"stack/foundation",
              "prNumber":72,
              "prState":"OPEN",
              "prUrl":"https://github.com/tellahq/opensession/pull/72",
              "prs":[
                {"repo":"tella-mac","branch":"stack/desktop","source":"attached","number":73,"title":"Desktop shell","state":"OPEN","url":"https://github.com/tellahq/tella-mac/pull/73"}
              ]
            }
            """
        )

        let rows = SessionPrSeries.rows(for: value)

        XCTAssertEqual(rows.map(\.number), [72, 73])
        XCTAssertEqual(rows.first?.target, SessionPrTarget(repo: "opensession", branch: "stack/foundation"))
        XCTAssertEqual(rows.first?.isPrimary, true)
    }
}
