import Foundation
import SwiftUI

/// Rounded brand square with the service's real logo, falling back to the
/// service's initial on a neutral tile. The web client's `IconTile` renders the
/// same marks from the same data — see `Brand` in BrandLogos.swift.
struct BrandTile: View {
    let name: String
    var size: CGFloat = 30

    var body: some View {
        let brand = Brand.colors(for: name)
        let logoScale = name.lowercased() == "tella" ? 1.0 : 0.56
        RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
            .fill(brand?.background ?? Color.secondary.opacity(0.16))
            .frame(width: size, height: size)
            .overlay {
                if let logo = Brand.logo(for: name) {
                    Group {
                        if logo.fills != nil || logo.opacities != nil {
                            ZStack {
                                ForEach(logo.paths.indices, id: \.self) { index in
                                    BrandLogoShape(
                                        logo: BrandLogo(viewBox: logo.viewBox, paths: [logo.paths[index]])
                                    )
                                    .fill(
                                        logo.fills.flatMap { index < $0.count ? $0[index] : nil }
                                            ?? brand?.foreground
                                            ?? .secondary
                                    )
                                    .opacity(logo.opacities.flatMap { index < $0.count ? $0[index] : nil } ?? 1)
                                }
                            }
                        } else {
                            BrandLogoShape(logo: logo)
                                .fill(
                                    brand?.foreground ?? .secondary,
                                    style: FillStyle(eoFill: logo.evenOdd)
                                )
                        }
                    }
                    .frame(width: size * logoScale, height: size * logoScale)
                } else {
                    Text(initial)
                        .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
                        .foregroundStyle(brand?.foreground ?? .secondary)
                }
            }
            .accessibilityHidden(true)
    }

    private var initial: String {
        guard let first = name.first else { return "?" }
        return first.uppercased()
    }
}

/// A logo's SVG path data, scaled to fit (aspect-preserving) whatever frame the
/// shape is given.
struct BrandLogoShape: Shape {
    let logo: BrandLogo

    func path(in rect: CGRect) -> Path {
        BrandLogoShape.cached(logo: logo, in: rect.size)
            .offsetBy(dx: rect.minX, dy: rect.minY)
    }

    /// Parsing is cheap but not free, and a shape's `path(in:)` runs on every
    /// redraw — the tiles are a fixed handful of marks at a fixed handful of
    /// sizes, so memoize them. `path(in:)` is nonisolated, hence the lock
    /// rather than main-actor state.
    private static let cache = PathCache()

    private static func cached(logo: BrandLogo, in size: CGSize) -> Path {
        let key = "\(logo.paths.first?.prefix(24) ?? "")|\(logo.paths.count)|\(size.width)x\(size.height)"
        if let hit = cache.path(for: key) { return hit }
        let path = build(logo: logo, in: size)
        cache.store(path, for: key)
        return path
    }

    private static func build(logo: BrandLogo, in size: CGSize) -> Path {
        let box = logo.viewBox
        guard box.width > 0, box.height > 0 else { return Path() }
        let scale = min(size.width / box.width, size.height / box.height)
        let transform = CGAffineTransform(
            translationX: (size.width - box.width * scale) / 2 - box.minX * scale,
            y: (size.height - box.height * scale) / 2 - box.minY * scale
        )
        .scaledBy(x: scale, y: scale)
        var path = Path()
        for data in logo.paths {
            path.addPath(SVGPath.parse(data), transform: transform)
        }
        return path
    }
}

private final class PathCache: @unchecked Sendable {
    private let lock = NSLock()
    private var paths: [String: Path] = [:]

    func path(for key: String) -> Path? {
        lock.lock()
        defer { lock.unlock() }
        return paths[key]
    }

    func store(_ path: Path, for key: String) {
        lock.lock()
        paths[key] = path
        lock.unlock()
    }
}

/// A small SVG path-data parser — enough of the grammar for logo marks: all of
/// M/L/H/V/C/S/Q/T/A/Z in both absolute and relative form, implicit repeated
/// coordinate sets, and the compressed number forms (".5", "1-2", "1e-3") the
/// minified marks are full of. Arcs are converted to cubics; SwiftUI's Path has
/// no elliptical-arc-to primitive.
enum SVGPath {
    static func parse(_ data: String) -> Path {
        var path = Path()
        var scanner = Scanner(data)
        var current = CGPoint.zero
        var subpathStart = CGPoint.zero
        var lastCubicControl: CGPoint?
        var lastQuadControl: CGPoint?
        var command: Character = " "

        while true {
            scanner.skipSeparators()
            if let letter = scanner.peekCommand() {
                scanner.advance()
                command = letter
            } else if scanner.isAtEnd {
                break
            } else if command == "M" {
                command = "L" // an implicit repeat of moveto is a lineto
            } else if command == "m" {
                command = "l"
            } else if command == " " {
                break // leading junk; nothing sensible to draw
            }

            let relative = command.isLowercase
            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
            }

            switch command.uppercased().first! {
            case "M":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                current = point(x, y)
                subpathStart = current
                path.move(to: current)
                lastCubicControl = nil
                lastQuadControl = nil
            case "L":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                current = point(x, y)
                path.addLine(to: current)
                lastCubicControl = nil
                lastQuadControl = nil
            case "H":
                guard let x = scanner.number() else { return path }
                current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.addLine(to: current)
                lastCubicControl = nil
                lastQuadControl = nil
            case "V":
                guard let y = scanner.number() else { return path }
                current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.addLine(to: current)
                lastCubicControl = nil
                lastQuadControl = nil
            case "C":
                guard let x1 = scanner.number(), let y1 = scanner.number(),
                      let x2 = scanner.number(), let y2 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return path }
                let control1 = point(x1, y1)
                let control2 = point(x2, y2)
                current = point(x, y)
                path.addCurve(to: current, control1: control1, control2: control2)
                lastCubicControl = control2
                lastQuadControl = nil
            case "S":
                guard let x2 = scanner.number(), let y2 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return path }
                let control1 = reflect(lastCubicControl, around: current)
                let control2 = point(x2, y2)
                current = point(x, y)
                path.addCurve(to: current, control1: control1, control2: control2)
                lastCubicControl = control2
                lastQuadControl = nil
            case "Q":
                guard let x1 = scanner.number(), let y1 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return path }
                let control = point(x1, y1)
                current = point(x, y)
                path.addQuadCurve(to: current, control: control)
                lastQuadControl = control
                lastCubicControl = nil
            case "T":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                let control = reflect(lastQuadControl, around: current)
                current = point(x, y)
                path.addQuadCurve(to: current, control: control)
                lastQuadControl = control
                lastCubicControl = nil
            case "A":
                guard let rx = scanner.number(), let ry = scanner.number(),
                      let rotation = scanner.number(), let largeArc = scanner.flag(),
                      let sweep = scanner.flag(), let x = scanner.number(),
                      let y = scanner.number() else { return path }
                let end = point(x, y)
                appendArc(
                    to: &path,
                    from: current,
                    to: end,
                    rx: rx,
                    ry: ry,
                    rotation: rotation,
                    largeArc: largeArc,
                    sweep: sweep
                )
                current = end
                lastCubicControl = nil
                lastQuadControl = nil
            case "Z":
                path.closeSubpath()
                current = subpathStart
                lastCubicControl = nil
                lastQuadControl = nil
                // Closepath takes no coordinates, so it cannot repeat. Left
                // as the pending command, a stray number after it would loop
                // here forever without consuming a byte; " " ends the parse
                // on the next pass instead.
                command = " "
            default:
                return path
            }
        }
        return path
    }

    private static func reflect(_ control: CGPoint?, around current: CGPoint) -> CGPoint {
        guard let control else { return current }
        return CGPoint(x: 2 * current.x - control.x, y: 2 * current.y - control.y)
    }

    /// Endpoint → center parameterization (SVG spec F.6.5), then one cubic per
    /// 90°-or-less slice of the sweep.
    private static func appendArc(
        to path: inout Path,
        from start: CGPoint,
        to end: CGPoint,
        rx: CGFloat,
        ry: CGFloat,
        rotation: CGFloat,
        largeArc: Bool,
        sweep: Bool
    ) {
        var rx = abs(rx)
        var ry = abs(ry)
        guard rx > 0, ry > 0, start != end else {
            path.addLine(to: end)
            return
        }
        let phi = rotation * .pi / 180
        let cosPhi = cos(phi)
        let sinPhi = sin(phi)
        let dx = (start.x - end.x) / 2
        let dy = (start.y - end.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy
        let y1 = -sinPhi * dx + cosPhi * dy

        // Scale up radii that are too small to span the endpoints.
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 {
            let root = sqrt(lambda)
            rx *= root
            ry *= root
        }

        let numerator = max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1)
        let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
        let coefficient = (largeArc == sweep ? -1.0 : 1.0) * sqrt(denominator == 0 ? 0 : numerator / denominator)
        let cx1 = coefficient * rx * y1 / ry
        let cy1 = -coefficient * ry * x1 / rx
        let center = CGPoint(
            x: cosPhi * cx1 - sinPhi * cy1 + (start.x + end.x) / 2,
            y: sinPhi * cx1 + cosPhi * cy1 + (start.y + end.y) / 2
        )

        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let length = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
            guard length > 0 else { return 0 }
            let sign: CGFloat = (ux * vy - uy * vx) < 0 ? -1 : 1
            return sign * acos(min(1, max(-1, dot / length)))
        }
        let startX = (x1 - cx1) / rx
        let startY = (y1 - cy1) / ry
        let endX = (-x1 - cx1) / rx
        let endY = (-y1 - cy1) / ry
        let theta = angle(1, 0, startX, startY)
        var delta = angle(startX, startY, endX, endY)
        if !sweep, delta > 0 { delta -= 2 * .pi }
        if sweep, delta < 0 { delta += 2 * .pi }

        func onArc(_ angle: CGFloat) -> CGPoint {
            CGPoint(
                x: center.x + rx * cos(angle) * cosPhi - ry * sin(angle) * sinPhi,
                y: center.y + rx * cos(angle) * sinPhi + ry * sin(angle) * cosPhi
            )
        }
        func slope(_ angle: CGFloat) -> CGPoint {
            CGPoint(
                x: -rx * sin(angle) * cosPhi - ry * cos(angle) * sinPhi,
                y: -rx * sin(angle) * sinPhi + ry * cos(angle) * cosPhi
            )
        }

        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let step = delta / CGFloat(segments)
        let k = 4.0 / 3.0 * tan(step / 4)
        var angleStart = theta
        for _ in 0..<segments {
            let angleEnd = angleStart + step
            let from = onArc(angleStart)
            let to = onArc(angleEnd)
            let fromSlope = slope(angleStart)
            let toSlope = slope(angleEnd)
            path.addCurve(
                to: to,
                control1: CGPoint(x: from.x + k * fromSlope.x, y: from.y + k * fromSlope.y),
                control2: CGPoint(x: to.x - k * toSlope.x, y: to.y - k * toSlope.y)
            )
            angleStart = angleEnd
        }
    }

    /// Byte scanner: path data is ASCII, and the marks are big enough that
    /// per-character `String` indexing showed up while parsing them.
    private struct Scanner {
        private let bytes: [UInt8]
        private var index = 0

        init(_ string: String) { bytes = Array(string.utf8) }

        var isAtEnd: Bool { index >= bytes.count }

        mutating func advance() { index += 1 }

        mutating func skipSeparators() {
            while index < bytes.count {
                let byte = bytes[index]
                if byte == 0x20 || byte == 0x2c || byte == 0x0a || byte == 0x0d || byte == 0x09 {
                    index += 1
                } else {
                    break
                }
            }
        }

        /// The next byte if it is a command letter (and not the start of a number).
        func peekCommand() -> Character? {
            guard index < bytes.count else { return nil }
            let byte = bytes[index]
            let isLetter = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
            guard isLetter, byte != 0x65, byte != 0x45 else { return nil } // e/E belong to numbers
            return Character(UnicodeScalar(byte))
        }

        /// Arc flags are single digits and may be packed against their
        /// neighbours ("0 0 1-2.5"), so they can't go through `number()`.
        mutating func flag() -> Bool? {
            skipSeparators()
            guard index < bytes.count, bytes[index] == 0x30 || bytes[index] == 0x31 else { return nil }
            defer { index += 1 }
            return bytes[index] == 0x31
        }

        mutating func number() -> CGFloat? {
            skipSeparators()
            let start = index
            if index < bytes.count, bytes[index] == 0x2b || bytes[index] == 0x2d { index += 1 }
            var sawDigit = false
            while index < bytes.count, bytes[index] >= 0x30, bytes[index] <= 0x39 {
                index += 1
                sawDigit = true
            }
            if index < bytes.count, bytes[index] == 0x2e {
                index += 1
                while index < bytes.count, bytes[index] >= 0x30, bytes[index] <= 0x39 {
                    index += 1
                    sawDigit = true
                }
            }
            guard sawDigit else {
                index = start
                return nil
            }
            if index < bytes.count, bytes[index] == 0x65 || bytes[index] == 0x45 {
                let exponentStart = index
                index += 1
                if index < bytes.count, bytes[index] == 0x2b || bytes[index] == 0x2d { index += 1 }
                var sawExponentDigit = false
                while index < bytes.count, bytes[index] >= 0x30, bytes[index] <= 0x39 {
                    index += 1
                    sawExponentDigit = true
                }
                if !sawExponentDigit { index = exponentStart }
            }
            let text = String(decoding: bytes[start..<index], as: UTF8.self)
            return Double(text).map { CGFloat($0) }
        }
    }
}
