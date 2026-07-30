import XCTest
@testable import OS1

final class WorktreeInfoTests: XCTestCase {
    func testSessionDecodesAttachedRepos() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(
                #"{"id":"bks-1","attachedRepos":[{"repo":"infra","branch":"feature","dir":"/tmp/infra"}]}"#.utf8
            )
        )

        XCTAssertEqual(session.attachedRepos?.first?.repo, "infra")
        XCTAssertEqual(session.attachedRepos?.first?.branch, "feature")
    }

    func testWorktreeDiffIgnoresRawPatch() throws {
        let response = try JSONDecoder().decode(
            OS1API.SessionDiffResponse.self,
            from: Data(
                #"{"repos":[{"repo":"backstage","dir":"/tmp/worktree","primary":true,"diff":{"branch":"feature","baseRef":"abc","files":[{"path":"OS1/App.swift","status":"modified","additions":4,"deletions":1}],"totalAdditions":4,"totalDeletions":1,"rawPatch":"large patch omitted by native model"}}]}"#.utf8
            )
        )

        XCTAssertEqual(response.repos.first?.diff.files.first?.path, "OS1/App.swift")
        XCTAssertEqual(response.repos.first?.diff.totalAdditions, 4)
    }
}
