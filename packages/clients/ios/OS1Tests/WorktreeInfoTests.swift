import XCTest
@testable import OS1

final class WorktreeInfoTests: XCTestCase {
    func testWorkspaceOverviewDecodesConversationMedia() throws {
        let overview = try JSONDecoder().decode(
            OS1API.WorkspaceOverview.self,
            from: Data(
                #"{"prompt":null,"lastMessage":null,"media":[{"kind":"image","src":"/api/sessions/os-1/transcript-image/entry-1/0","sessionId":"os-1","sessionTitle":"Polish workspace info","at":"2026-08-17T09:10:00Z"},{"kind":"video","src":"/media?path=%2Ftmp%2Fdemo.mp4","sessionId":"os-2","at":"2026-08-17T09:12:00Z"}]}"#.utf8
            )
        )

        XCTAssertEqual(overview.media.map(\.kind), ["image", "video"])
        XCTAssertEqual(overview.media.first?.sessionTitle, "Polish workspace info")
        XCTAssertEqual(overview.media.last?.sessionId, "os-2")
    }

    func testWorkspaceOverviewDefaultsMissingMediaToEmpty() throws {
        let overview = try JSONDecoder().decode(
            OS1API.WorkspaceOverview.self,
            from: Data(#"{"prompt":null}"#.utf8)
        )

        XCTAssertTrue(overview.media.isEmpty)
        XCTAssertNil(overview.lastMessage)
    }

    func testWorkspaceOverviewKeepsUnknownMediaKindsForForwardCompatibility() throws {
        let overview = try JSONDecoder().decode(
            OS1API.WorkspaceOverview.self,
            from: Data(
                #"{"media":[{"kind":"audio","src":"/media?path=x","sessionId":"os-1","at":"2026-08-17T09:10:00Z"}]}"#.utf8
            )
        )

        XCTAssertEqual(overview.media.first?.kind, "audio")
    }

    func testVisualAssetsAreOnlyPicturesAndRecordings() {
        func asset(_ path: String) -> OS1API.SessionAsset {
            .init(path: path, size: 1, mtime: "")
        }

        XCTAssertEqual(AssetVisualKind.of(asset("shots/AFTER.PNG")), .image)
        XCTAssertEqual(AssetVisualKind.of(asset("demo.mov")), .video)
        XCTAssertEqual(AssetVisualKind.of(asset("clip.webm")), .video)
        XCTAssertNil(AssetVisualKind.of(asset("report.html")))
        XCTAssertNil(AssetVisualKind.of(asset("diagram.svg")))
        XCTAssertNil(AssetVisualKind.of(asset("audio.wav")))
        XCTAssertNil(AssetVisualKind.of(asset("notes.md")))
    }

    func testSessionAssetDecodesDescription() throws {
        let asset = try JSONDecoder().decode(
            OS1API.SessionAsset.self,
            from: Data(
                #"{"path":"report.html","size":42,"mtime":"2026-08-17T09:10:00Z","description":"Release readiness report"}"#.utf8
            )
        )

        XCTAssertEqual(asset.description, "Release readiness report")
    }

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

    func testSessionDecodesSandboxReference() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(
                #"{"id":"bks-1","sandbox":{"provider":"daytona","sandboxId":"sbx-1","workspace":"volume"}}"#.utf8
            )
        )

        XCTAssertEqual(session.sandbox?.provider, "daytona")
        XCTAssertEqual(session.sandbox?.sandboxId, "sbx-1")
        XCTAssertEqual(session.sandbox?.workspace, "volume")
    }

    func testSandboxStatusToleratesMissingAndNewFields() throws {
        let status = try JSONDecoder().decode(
            SessionSandboxStatus.self,
            from: Data(#"{"enabled":true,"provider":"daytona","status":"hibernating","futureField":true}"#.utf8)
        )

        XCTAssertEqual(status.enabled, true)
        XCTAssertEqual(status.provider, "daytona")
        XCTAssertEqual(status.status, "hibernating")
        XCTAssertNil(status.sandboxId)
        XCTAssertNil(status.canResume)
    }

    func testPullRequestSummaryPrefersFailingChecks() throws {
        let pullRequest = try JSONDecoder().decode(
            PrDetails.self,
            from: Data(
                #"{"number":42,"state":"OPEN","checks":[{"name":"Tests","status":"COMPLETED","conclusion":"FAILURE"},{"name":"Deploy","status":"IN_PROGRESS"}]}"#.utf8
            )
        )

        XCTAssertEqual(pullRequest.summary, .failing)
        XCTAssertTrue(pullRequest.isOpen)
    }

    func testPullRequestSummaryPrefersTerminalState() throws {
        let pullRequest = try JSONDecoder().decode(
            PrDetails.self,
            from: Data(
                #"{"number":42,"state":"MERGED","isDraft":true,"checks":[{"name":"Tests","status":"COMPLETED","conclusion":"FAILURE"}]}"#.utf8
            )
        )

        XCTAssertEqual(pullRequest.summary, .merged)
        XCTAssertFalse(pullRequest.isOpen)
    }
}
