import XCTest
@testable import OS1

final class ImageRegionGeometryTests: XCTestCase {
    func testSelectionClampsAndSupportsReverseDrag() {
        let region = ImageRegion.between(
            CGPoint(x: 0.8, y: 1.2),
            CGPoint(x: -0.1, y: 0.25)
        )

        XCTAssertEqual(region, ImageRegion(x: 0, y: 0.25, width: 0.8, height: 0.75))
    }

    func testMoveStopsAtImageEdgeWithoutShrinking() {
        let region = ImageRegion(x: 0.6, y: 0.3, width: 0.3, height: 0.4)

        XCTAssertEqual(
            region.moved(dx: 0.5, dy: -0.8),
            ImageRegion(x: 0.7, y: 0, width: 0.3, height: 0.4)
        )
    }

    func testCornerResizeKeepsOppositeCornerAndMinimumSize() {
        let region = ImageRegion(x: 0.2, y: 0.2, width: 0.5, height: 0.5)
        let resized = region.resized(
            from: .southEast,
            dx: -0.48,
            dy: -0.48,
            minimum: CGSize(width: 0.1, height: 0.1)
        )

        XCTAssertEqual(resized.x, 0.2, accuracy: 0.0001)
        XCTAssertEqual(resized.y, 0.2, accuracy: 0.0001)
        XCTAssertEqual(resized.width, 0.1, accuracy: 0.0001)
        XCTAssertEqual(resized.height, 0.1, accuracy: 0.0001)
    }

    func testPixelCropRoundsOutwardAndStaysInBounds() {
        let region = ImageRegion(x: 0.1, y: 0.2, width: 0.35, height: 0.4)

        XCTAssertEqual(
            region.pixelRect(imageSize: CGSize(width: 101, height: 79)),
            CGRect(x: 10, y: 15, width: 36, height: 33)
        )
    }

    func testLargeCropOutputIsBoundedWithoutChangingAspectRatio() {
        let size = ImageRegionCrop.outputSize(for: CGSize(width: 4_000, height: 1_000))

        XCTAssertEqual(size, CGSize(width: 2_000, height: 500))
    }
}

@MainActor
final class ImageRegionCommentHandoffTests: XCTestCase {
    func testRegionCommentQueuesIsolatedMessageAndPreservesComposer() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("os1-region-comment-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = Outbox(directory: directory, monitorNetwork: false)
        outbox.transport = { _, _ in .unavailable("offline") }
        let viewModel = SessionViewModel(session: Session(id: "bks-1"), outbox: outbox)
        let original = AttachedImage(id: "draft", jpegData: Data([1, 2, 3]))
        let crop = AttachedImage(
            id: "crop",
            jpegData: Data([4, 5, 6]),
            mediaType: "image/png"
        )
        viewModel.draft = "Existing draft"
        viewModel.attachedImages = [original]

        XCTAssertTrue(viewModel.sendImageRegionComment("  Direct comment  ", image: crop))

        XCTAssertEqual(viewModel.draft, "Existing draft")
        XCTAssertEqual(viewModel.attachedImages, [original])
        let item = try XCTUnwrap(outbox.items(for: "bks-1").first)
        XCTAssertEqual(item.content, "Direct comment")
        XCTAssertEqual(outbox.images(for: item), [crop.dataURL])
    }
}
