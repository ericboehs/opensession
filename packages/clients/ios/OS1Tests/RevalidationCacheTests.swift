import XCTest
@testable import OS1

/// The rules that keep a conditional poll honest: never ask on a validator
/// whose body is gone, and never answer with a body from somewhere else.
@MainActor
final class RevalidationCacheTests: XCTestCase {
    private let path = "/api/sessions?archived=exclude"
    private let connection = "https://os.example.test|token-a"
    private var cache = RevalidationCache()

    override func setUp() async throws {
        cache = RevalidationCache()
    }

    /// Nothing stored means nothing to fall back on, so the first request of a
    /// launch goes out plain and gets a body.
    func testNoValidatorBeforeABodyIsStored() {
        XCTAssertNil(cache.validator(for: path, connection: connection))
    }

    func testAStoredBodyIsOfferedBackWithItsValidator() {
        cache.store(["a", "b"], etag: "\"abc\"", for: path, connection: connection)

        XCTAssertEqual(cache.validator(for: path, connection: connection), "\"abc\"")
        XCTAssertEqual(cache.value([String].self, for: path), ["a", "b"])
    }

    /// A second server or a new token is a different answer to the same
    /// question, and its ETags are not ours.
    func testAChangedConnectionDropsWhatTheLastOneStored() {
        cache.store(["a"], etag: "\"abc\"", for: path, connection: connection)

        let other = "https://os.example.test|token-b"
        XCTAssertNil(cache.validator(for: path, connection: other))
        XCTAssertNil(cache.value([String].self, for: path))
    }

    /// Same connection, same path: the entry survives, which is the whole
    /// point of it.
    func testTheSameConnectionKeepsIt() {
        cache.store(["a"], etag: "\"abc\"", for: path, connection: connection)

        XCTAssertEqual(cache.validator(for: path, connection: connection), "\"abc\"")
    }

    /// A body is only handed to a caller expecting the type it was decoded
    /// as. Anything else reads as a miss, which costs a plain request.
    func testABodyIsNotHandedToADifferentType() {
        cache.store(["a"], etag: "\"abc\"", for: path, connection: connection)

        XCTAssertNil(cache.value(Int.self, for: path))
    }

    /// What the 304-with-no-body path does before it asks again.
    func testForgettingLeavesNothingToAskOn() {
        cache.store(["a"], etag: "\"abc\"", for: path, connection: connection)
        cache.forget(path)

        XCTAssertNil(cache.validator(for: path, connection: connection))
        XCTAssertNil(cache.value([String].self, for: path))
    }

    /// Paths are remembered apart: the live list and the archived index poll
    /// on their own clocks and change at their own rates.
    func testPathsAreRememberedApart() {
        let archived = "/api/sessions?archived=only&slim=1"
        cache.store(["live"], etag: "\"live\"", for: path, connection: connection)
        cache.store(["old"], etag: "\"old\"", for: archived, connection: connection)

        XCTAssertEqual(cache.validator(for: path, connection: connection), "\"live\"")
        XCTAssertEqual(cache.validator(for: archived, connection: connection), "\"old\"")
        XCTAssertEqual(cache.value([String].self, for: archived), ["old"])
    }
}
