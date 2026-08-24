import XCTest
@testable import OS1

/// The rewrite that makes "saved it as `report.html`" tappable. It shares its
/// machinery with `FileLinks` (which is where the timidity of the matcher is
/// tested); what matters here is that it points at the assets it was given,
/// stays out of the way of a file link, and survives the round trip back to a
/// path when the link is tapped.
@MainActor
final class AssetLinksTests: XCTestCase {
    private let session = "os-assets-test"

    override func setUp() async throws {
        AssetLinks.register(
            paths: ["report.html", "viz/index.html", "shots/before.png"],
            for: session
        )
    }

    /// Assets draw as chips, whose label rides in the destination's query.
    /// `chipsAsLinks` turns one back into the link it stands for, so these
    /// expectations stay about which names are claimed.
    private func linkify(_ markdown: String) -> String {
        chipsAsLinks(AssetLinks.linkify(markdown, sessionId: session))
    }

    func testWrittenAssetBecomesALink() {
        XCTAssertEqual(
            linkify("Saved it as `report.html` — open it there."),
            "Saved it as [report.html](os1asset:report.html) — open it there."
        )
    }

    func testNestedAssetLinksByItsFullPath() {
        XCTAssertEqual(
            linkify("the page is viz/index.html"),
            "the page is [viz/index.html](os1asset:viz/index.html)"
        )
    }

    /// A trailing segment is how anyone refers to a nested file in a sentence,
    /// and it still opens the one file it can only mean.
    func testTrailingSegmentNamesTheSameFile() {
        XCTAssertEqual(
            linkify("see before.png"),
            "see [before.png](os1asset:shots/before.png)"
        )
    }

    /// Nothing was written under that name, so nothing is claimed.
    func testUnwrittenNameIsLeftAlone() {
        XCTAssertEqual(linkify("check summary.html"), "check summary.html")
    }

    /// Scratch assets do not use the composer's repo-file `@path` syntax.
    func testAtPrefixedNameIsLeftAlone() {
        XCTAssertEqual(linkify("check @report.html"), "check @report.html")
        XCTAssertEqual(linkify("check `@report.html`"), "check `@report.html`")
    }

    /// The cap protects suffix aliases, never a real file path. Sessions may
    /// contain up to 2,000 assets, and every exact name must keep opening.
    func testEveryExactPathLinksBeyondTheAliasCap() {
        let paths = Set((0...600).map { String(format: "asset-%04d.txt", $0) })
        AssetLinks.register(paths: paths, for: session)
        XCTAssertEqual(
            linkify("open asset-0600.txt"),
            "open [asset-0600.txt](os1asset:asset-0600.txt)"
        )
    }

    /// Another session's transcript must not link this session's scratch.
    func testUnknownSessionLinksNothing() {
        let text = "Saved it as report.html"
        XCTAssertEqual(AssetLinks.linkify(text, sessionId: nil), text)
        XCTAssertEqual(AssetLinks.linkify(text, sessionId: "os-other"), text)
    }

    /// `FileLinks` runs first, so a name that is both keeps its diff: the link
    /// it already made is copied through untouched.
    func testExistingLinkSurvives() {
        let text = "see [report.html](os1file:report.html)"
        XCTAssertEqual(linkify(text), text)
    }

    func testPathRoundTripsFromItsURL() {
        XCTAssertEqual(
            AssetLinks.path(from: URL(string: "os1asset:viz/index.html")!),
            "viz/index.html"
        )
        XCTAssertNil(AssetLinks.path(from: URL(string: "os1file:report.html")!))
        XCTAssertNil(AssetLinks.path(from: URL(string: "https://os.tella.dev/x")!))
    }

    func testMediaSourceResolvesToARegisteredAsset() {
        let absolute = "/home/ubuntu/.opensession-assets/os-old/viz/index.html"
        let encoded = absolute.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!
        XCTAssertEqual(
            AssetLinks.path(
                forMediaSource: "https://os.tella.dev/media?path=\(encoded)#t=0.1",
                sessionId: session
            ),
            "viz/index.html"
        )
    }

    func testMediaSourceNeverGuessesAnUnregisteredAsset() {
        let other = "/home/ubuntu/.opensession-assets/os-old/demo.mov"
        let ordinary = "/tmp/demo.mov"
        XCTAssertNil(AssetLinks.path(
            forMediaSource: "/media?path=\(other)",
            sessionId: session
        ))
        XCTAssertNil(AssetLinks.path(
            forMediaSource: "/media?path=\(ordinary)",
            sessionId: session
        ))
        XCTAssertNil(AssetLinks.path(forMediaSource: "blob:video", sessionId: session))
    }

    /// The two schemes are separate registries: an asset link is not a file
    /// link, whatever the paths happen to be called.
    func testSchemesDoNotCross() {
        FileLinks.register(paths: ["report.html"], for: session)
        XCTAssertEqual(
            FileLinks.linkify("open report.html", sessionId: session),
            "open [report.html](os1file:report.html)"
        )
        XCTAssertNil(FileLinks.path(from: URL(string: "os1asset:report.html")!))
        FileLinks.register(paths: [], for: session)
    }
}
