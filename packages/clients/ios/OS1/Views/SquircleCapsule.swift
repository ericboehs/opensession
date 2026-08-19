import CoreGraphics
import SwiftUI

/// A pill whose ends are superellipses rather than semicircles: the shape the
/// web draws for a chip, in the one place `Capsule` cannot follow.
///
/// SwiftUI has no superellipse. `RoundedRectangle(style: .continuous)` is
/// Apple's own squircle, but only while its radius is smaller than half the
/// side: at exactly half, both it and `Capsule(style: .continuous)` collapse
/// to circular ends, which is measurable against the rendered corner rather
/// than a matter of opinion. So a chip that wants the web's shape has to draw
/// it.
///
/// The curve is |x|^4 + |y|^4 = r^4, which is what Chrome renders for
/// `corner-shape: squircle` (CSS's `superellipse(2)`, i.e. exponent 2^2).
/// Measured off a rendered pill at 10x, the fitted exponent is 4.06 and the
/// 45-degree point sits at 0.8417r against the exact 0.8409r, the excess
/// being the edge's antialiasing. A circle would put that point at 0.7071r,
/// which is the whole difference between the two shapes: a squircle carries
/// its width further into the corner before turning, so the end reads as a
/// held shape rather than a swept one.
///
/// Note this is what the web AUTHORS, not what every browser paints. WebKit
/// ships no `corner-shape` at all, so Safari and the iOS PWA fall back to
/// circular ends. Matching Chrome is matching the intent.
struct SquircleCapsule: Shape {
    /// s in |x|^s + |y|^s = 1.
    static let exponent: Double = 4

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard rect.width > 0, rect.height > 0 else { return path }

        // CSS clamps a radius that cannot fit its side; at half the shorter
        // side the corners meet and the shape is a pill, which is what the
        // chip's 12pt radius has always resolved to at this height.
        let r = min(rect.width, rect.height) / 2
        let quarter = Self.unitQuarter

        // Every corner walks the same unit quarter, placed into its own axes,
        // so the four cannot drift apart. Its first point is where the edge
        // before it ended, hence the drop.
        func corner(_ place: (CGPoint) -> CGPoint) {
            for point in quarter.dropFirst() {
                path.addLine(to: place(CGPoint(x: point.x * r, y: point.y * r)))
            }
        }

        let left = rect.minX, right = rect.maxX
        let top = rect.minY, bottom = rect.maxY

        path.move(to: CGPoint(x: left + r, y: top))

        path.addLine(to: CGPoint(x: right - r, y: top))
        let topRight = CGPoint(x: right - r, y: top + r)
        corner { CGPoint(x: topRight.x + $0.x, y: topRight.y - $0.y) }

        path.addLine(to: CGPoint(x: right, y: bottom - r))
        let bottomRight = CGPoint(x: right - r, y: bottom - r)
        corner { CGPoint(x: bottomRight.x + $0.y, y: bottomRight.y + $0.x) }

        path.addLine(to: CGPoint(x: left + r, y: bottom))
        let bottomLeft = CGPoint(x: left + r, y: bottom - r)
        corner { CGPoint(x: bottomLeft.x - $0.x, y: bottomLeft.y + $0.y) }

        path.addLine(to: CGPoint(x: left, y: top + r))
        let topLeft = CGPoint(x: left + r, y: top + r)
        corner { CGPoint(x: topLeft.x - $0.y, y: topLeft.y - $0.x) }

        path.closeSubpath()
        return path
    }

    /// The quarter curve from (0, 1) to (1, 0), in units of the radius.
    ///
    /// Sampled in x across the first eighth and mirrored across the diagonal
    /// for the second, because the obvious parametrizations are each unusable
    /// at one end: x = cos(t)^(1/2) sprints away from the axis (its slope
    /// there is infinite), and sampling x alone does the same at the other
    /// corner. Over the eighth both coordinates move at comparable speed, so
    /// evenly spaced samples stay evenly spaced on the curve.
    ///
    /// One fixed table rather than a per-size one: 24 samples an eighth put
    /// the widest chord 0.4pt apart on a chip and 1.8pt apart on a shape the
    /// size of a card, and the error a chord commits is a fraction of its own
    /// length squared over the radius: 0.004pt and 0.02pt, both far under a
    /// device pixel. Sizing the table to the shape would buy nothing and cost
    /// a cache.
    private static let unitQuarter: [CGPoint] = {
        let s = exponent
        let samples = 24
        let split = pow(0.5, 1 / s) // where the curve crosses its diagonal
        var eighth: [CGPoint] = []
        eighth.reserveCapacity(samples + 1)
        for step in 0...samples {
            let x = split * Double(step) / Double(samples)
            eighth.append(CGPoint(x: x, y: pow(1 - pow(x, s), 1 / s)))
        }
        // Read backwards with its axes swapped, the eighth is the quarter's
        // other half. The diagonal point they share is written once.
        let mirrored = eighth.reversed().map { CGPoint(x: $0.y, y: $0.x) }
        return eighth + mirrored.dropFirst()
    }()
}
