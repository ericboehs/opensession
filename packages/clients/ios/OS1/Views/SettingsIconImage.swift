import Foundation
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Re-encode a picked image as the square PNG accepted by settings icon routes.
enum SettingsIconImage {
    static func squarePNG(_ raw: Data, side: CGFloat = 256) -> Data? {
        #if canImport(UIKit)
        guard let image = UIImage(data: raw) else { return nil }
        let size = CGSize(width: side, height: side)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = false
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            let scale = min(side / image.size.width, side / image.size.height)
            let drawn = CGSize(
                width: image.size.width * scale,
                height: image.size.height * scale
            )
            image.draw(in: CGRect(
                x: (side - drawn.width) / 2,
                y: (side - drawn.height) / 2,
                width: drawn.width,
                height: drawn.height
            ))
        }
        return rendered.pngData()
        #else
        guard let source = NSImage(data: raw) else { return nil }
        let target = NSImage(size: NSSize(width: side, height: side))
        target.lockFocus()
        let scale = min(side / source.size.width, side / source.size.height)
        let drawn = NSSize(width: source.size.width * scale, height: source.size.height * scale)
        source.draw(in: NSRect(
            x: (side - drawn.width) / 2,
            y: (side - drawn.height) / 2,
            width: drawn.width,
            height: drawn.height
        ))
        target.unlockFocus()
        guard let tiff = target.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff)
        else { return nil }
        return bitmap.representation(using: .png, properties: [:])
        #endif
    }
}
