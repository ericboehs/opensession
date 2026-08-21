import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// A rectangle expressed against an image's displayed bounds. Normalized
/// coordinates keep the same pixels selected when the keyboard or window
/// changes the available space.
struct ImageRegion: Equatable, Sendable {
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var height: CGFloat

    static func between(_ start: CGPoint, _ end: CGPoint) -> ImageRegion {
        let a = CGPoint(x: clamp(start.x), y: clamp(start.y))
        let b = CGPoint(x: clamp(end.x), y: clamp(end.y))
        return ImageRegion(
            x: min(a.x, b.x),
            y: min(a.y, b.y),
            width: abs(b.x - a.x),
            height: abs(b.y - a.y)
        )
    }

    func moved(dx: CGFloat, dy: CGFloat) -> ImageRegion {
        let boundedWidth = min(1, max(0, width))
        let boundedHeight = min(1, max(0, height))
        return ImageRegion(
            x: min(1 - boundedWidth, max(0, x + dx)),
            y: min(1 - boundedHeight, max(0, y + dy)),
            width: boundedWidth,
            height: boundedHeight
        )
    }

    func resized(
        from handle: ImageRegionHandle,
        dx: CGFloat,
        dy: CGFloat,
        minimum: CGSize = .zero
    ) -> ImageRegion {
        let left = x
        let right = x + width
        let top = y
        let bottom = y + height
        let horizontal: (CGFloat, CGFloat)
        if handle.movesWest {
            horizontal = Self.span(anchor: right, moving: left + dx, minimum: minimum.width)
        } else if handle.movesEast {
            horizontal = Self.span(anchor: left, moving: right + dx, minimum: minimum.width)
        } else {
            horizontal = (Self.clamp(left), Self.clamp(right))
        }
        let vertical: (CGFloat, CGFloat)
        if handle.movesNorth {
            vertical = Self.span(anchor: bottom, moving: top + dy, minimum: minimum.height)
        } else if handle.movesSouth {
            vertical = Self.span(anchor: top, moving: bottom + dy, minimum: minimum.height)
        } else {
            vertical = (Self.clamp(top), Self.clamp(bottom))
        }
        return ImageRegion(
            x: horizontal.0,
            y: vertical.0,
            width: horizontal.1 - horizontal.0,
            height: vertical.1 - vertical.0
        )
    }

    func pixelRect(imageSize: CGSize) -> CGRect {
        let sourceWidth = max(1, imageSize.width.rounded())
        let sourceHeight = max(1, imageSize.height.rounded())
        let originX = min(sourceWidth - 1, max(0, floor(Self.clamp(x) * sourceWidth)))
        let originY = min(sourceHeight - 1, max(0, floor(Self.clamp(y) * sourceHeight)))
        let right = min(
            sourceWidth,
            max(originX + 1, ceil(Self.clamp(x + width) * sourceWidth))
        )
        let bottom = min(
            sourceHeight,
            max(originY + 1, ceil(Self.clamp(y + height) * sourceHeight))
        )
        return CGRect(x: originX, y: originY, width: right - originX, height: bottom - originY)
    }

    private static func span(
        anchor: CGFloat,
        moving: CGFloat,
        minimum: CGFloat
    ) -> (CGFloat, CGFloat) {
        let fixed = clamp(anchor)
        let minimum = min(1, max(0, minimum))
        var edge = clamp(moving)
        if abs(edge - fixed) < minimum {
            edge = edge >= fixed ? fixed + minimum : fixed - minimum
        }
        return (max(0, min(fixed, edge)), min(1, max(fixed, edge)))
    }

    private static func clamp(_ value: CGFloat) -> CGFloat {
        guard value.isFinite else { return 0 }
        return min(1, max(0, value))
    }
}

enum ImageRegionHandle: CaseIterable, Sendable {
    case northWest, north, northEast, east, southEast, south, southWest, west

    var movesNorth: Bool { self == .northWest || self == .north || self == .northEast }
    var movesEast: Bool { self == .northEast || self == .east || self == .southEast }
    var movesSouth: Bool { self == .southEast || self == .south || self == .southWest }
    var movesWest: Bool { self == .southWest || self == .west || self == .northWest }

}

enum ImageRegionCrop {
    static let maximumEdge = 2_000

    static func outputSize(for size: CGSize) -> CGSize {
        let width = max(1, size.width.rounded())
        let height = max(1, size.height.rounded())
        let scale = min(1, CGFloat(maximumEdge) / max(width, height))
        return CGSize(
            width: max(1, (width * scale).rounded()),
            height: max(1, (height * scale).rounded())
        )
    }

    #if canImport(UIKit)
    static func attachment(from image: UIImage, region: ImageRegion) -> AttachedImage? {
        guard let source = normalizedCGImage(image) else { return nil }
        return attachment(from: source, region: region)
    }

    private static func normalizedCGImage(_ image: UIImage) -> CGImage? {
        if image.imageOrientation == .up, let cgImage = image.cgImage { return cgImage }
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        let rendered = UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
        return rendered.cgImage
    }
    #else
    static func attachment(from image: NSImage, region: ImageRegion) -> AttachedImage? {
        var rect = CGRect(origin: .zero, size: image.size)
        guard let source = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
        else { return nil }
        return attachment(from: source, region: region)
    }
    #endif

    private static func attachment(from source: CGImage, region: ImageRegion) -> AttachedImage? {
        let cropRect = region.pixelRect(
            imageSize: CGSize(width: source.width, height: source.height)
        )
        guard let cropped = source.cropping(to: cropRect) else { return nil }
        let target = outputSize(for: cropRect.size)
        guard let context = CGContext(
            data: nil,
            width: Int(target.width),
            height: Int(target.height),
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(cropped, in: CGRect(origin: .zero, size: target))
        guard let output = context.makeImage() else { return nil }

        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data, UTType.png.identifier as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(destination, output, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return AttachedImage(
            id: UUID().uuidString,
            jpegData: data as Data,
            mediaType: "image/png"
        )
    }
}
