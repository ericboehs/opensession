import XCTest
@testable import OS1

final class RepoTileTests: XCTestCase {
    func testProductRepositoriesUseBundledIconAsFallback() {
        XCTAssertTrue(RepoTile.usesBundledProductIcon(for: "opensession"))
        XCTAssertTrue(RepoTile.usesBundledProductIcon(for: "backstage"))
        XCTAssertFalse(RepoTile.usesBundledProductIcon(for: "tella-fusion"))
    }
}
