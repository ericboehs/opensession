import XCTest
@testable import OS1

final class TranscriptSearchTests: XCTestCase {
    func testSearchPathPreservesTheWholeQuery() throws {
        let path = OS1API.transcriptSearchPath(query: "cache + native & PWA")
        let components = try XCTUnwrap(URLComponents(string: path))
        XCTAssertEqual(components.path, "/api/sessions/search")
        XCTAssertEqual(components.queryItems, [
            URLQueryItem(name: "q", value: "cache + native & PWA")
        ])
    }
}
