import XCTest
@testable import OS1

final class MarkdownStreamSourceTests: XCTestCase {
    func testYieldsInitialSnapshotAndUpdates() async {
        let source = MarkdownStreamSource(initialText: "Hello")
        var values = source.text.makeAsyncIterator()

        let initial = await values.next()
        XCTAssertEqual(initial, "Hello")

        source.update("Hello [link](https://example.com)")
        let update = await values.next()
        XCTAssertEqual(update, "Hello [link](https://example.com)")
    }

    func testDropsStaleSnapshotsWhenConsumerFallsBehind() async {
        let source = MarkdownStreamSource(initialText: "")
        source.update("```swift")
        source.update("```swift\nprint(1)\n```")
        var values = source.text.makeAsyncIterator()

        let latest = await values.next()
        XCTAssertEqual(latest, "```swift\nprint(1)\n```")
    }
}
