import CoreGraphics
import SwiftUI
import XCTest

@testable import OS1

/// The chip's pill, measured the way the web's was: not "does the path build"
/// but "where is its edge", since a shape that silently fell back to circular
/// ends would build a perfectly good path.
///
/// Every assertion probes the rendered geometry through `Path.contains`, so it
/// holds whatever the sampling inside the shape does.
final class SquircleCapsuleTests: XCTestCase {
    private let rect = CGRect(x: 0, y: 0, width: 200, height: 80)
    private var radius: CGFloat { 40 }

    /// Where the shape's edge sits along a ray leaving a corner's centre.
    private func edge(
        of path: Path,
        from centre: CGPoint,
        angle: Double
    ) -> CGFloat {
        let direction = CGPoint(x: cos(angle), y: sin(angle))
        var inside: CGFloat = 0
        var outside: CGFloat = radius * 4
        for _ in 0..<50 {
            let middle = (inside + outside) / 2
            let point = CGPoint(
                x: centre.x + direction.x * middle,
                y: centre.y + direction.y * middle
            )
            if path.contains(point) { inside = middle } else { outside = middle }
        }
        return (inside + outside) / 2
    }

    /// The corner centres, and the quadrant each one's corner points into.
    private var corners: [(centre: CGPoint, angles: ClosedRange<Double>)] {
        [
            (CGPoint(x: rect.minX + radius, y: rect.minY + radius), .pi ... 1.5 * .pi),
            (CGPoint(x: rect.maxX - radius, y: rect.minY + radius), 1.5 * .pi ... 2 * .pi),
            (CGPoint(x: rect.maxX - radius, y: rect.maxY - radius), 0 ... 0.5 * .pi),
            (CGPoint(x: rect.minX + radius, y: rect.maxY - radius), 0.5 * .pi ... .pi),
        ]
    }

    func testEveryCornerFollowsTheSuperellipse() {
        let path = SquircleCapsule().path(in: rect)
        for (centre, angles) in corners {
            for step in 0...20 {
                let angle = angles.lowerBound
                    + (angles.upperBound - angles.lowerBound) * Double(step) / 20
                let distance = edge(of: path, from: centre, angle: angle)
                let x = abs(cos(angle)) * distance / radius
                let y = abs(sin(angle)) * distance / radius
                // |x|^4 + |y|^4 = 1 on the curve. A circle would read 1 here
                // only on the axes, and 0.5 at 45 degrees.
                let unit = pow(x, SquircleCapsule.exponent)
                    + pow(y, SquircleCapsule.exponent)
                XCTAssertEqual(unit, 1, accuracy: 0.01, "angle \(angle) at \(centre)")
            }
        }
    }

    /// The control: the same probe run against `Capsule`, which must fail the
    /// test above. Without it, a shape that drew nothing at all would pass
    /// every containment check by never being inside anything.
    func testACapsuleWouldNotPassThatTest() {
        let path = Capsule().path(in: rect)
        let centre = CGPoint(x: rect.minX + radius, y: rect.minY + radius)
        let diagonal = edge(of: path, from: centre, angle: 1.25 * .pi)
        XCTAssertEqual(diagonal, radius, accuracy: 0.5, "a circular end")

        let squircle = SquircleCapsule().path(in: rect)
        let ours = edge(of: squircle, from: centre, angle: 1.25 * .pi)
        // 2^(1/4) further out: the corner the eye actually reads.
        XCTAssertEqual(ours, radius * pow(2, 0.25), accuracy: 0.5)
        XCTAssertGreaterThan(ours - diagonal, radius * 0.15)
    }

    func testTheEndsStayInsideTheRect() {
        let path = SquircleCapsule().path(in: rect)
        let bounds = path.boundingRect
        XCTAssertEqual(bounds.minX, rect.minX, accuracy: 0.01)
        XCTAssertEqual(bounds.minY, rect.minY, accuracy: 0.01)
        XCTAssertEqual(bounds.maxX, rect.maxX, accuracy: 0.01)
        XCTAssertEqual(bounds.maxY, rect.maxY, accuracy: 0.01)
    }

    /// The chip's own size, where a wrong radius would be invisible in a unit
    /// test on a 200x80 rect: the ends must still meet at the middle.
    func testAChipSizedPillIsStillAPill() {
        let chip = CGRect(x: 0, y: 0, width: 96, height: 23)
        let path = SquircleCapsule().path(in: chip)
        XCTAssertTrue(path.contains(CGPoint(x: chip.midX, y: chip.minY + 0.5)))
        XCTAssertTrue(path.contains(CGPoint(x: 11.5, y: chip.midY)))
        // The corner a circular capsule would have cut away.
        let inset = 23 / 2 * (1 - pow(0.5, 0.25))
        let held = CGPoint(x: inset + 0.4, y: inset + 0.4)
        XCTAssertTrue(path.contains(held))
        XCTAssertFalse(Capsule().path(in: chip).contains(held))
    }

    /// A square gets a squircle rather than a stretched pill, and nothing
    /// degenerate traps.
    func testDegenerateSizes() {
        XCTAssertTrue(SquircleCapsule().path(in: .zero).isEmpty)
        XCTAssertTrue(
            SquircleCapsule().path(in: CGRect(x: 0, y: 0, width: 10, height: 0)).isEmpty
        )
        let square = SquircleCapsule().path(in: CGRect(x: 0, y: 0, width: 40, height: 40))
        XCTAssertTrue(square.contains(CGPoint(x: 20, y: 20)))
        XCTAssertFalse(square.contains(CGPoint(x: 1, y: 1)))
    }
}
