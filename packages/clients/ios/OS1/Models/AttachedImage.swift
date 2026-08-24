import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// One image attached to a message or new-session prompt, normalized at pick
/// time: downscaled to the vision path's useful size and re-encoded as JPEG so
/// a 12 MP camera photo doesn't ride the WebSocket at 40 MB of base64.
struct AttachedImage: Identifiable, Equatable, Sendable {
    let id: String
    let jpegData: Data
    /// What the bytes actually are. Anything this app encodes itself is JPEG,
    /// but an image adopted from an existing message can be whatever the
    /// client that sent it produced — a web screenshot is a PNG — and
    /// re-labelling those bytes `image/jpeg` on the way back out hands the
    /// model a mislabelled attachment.
    let mediaType: String

    /// The wire form the server's composer paths expect (`msg.images`).
    var dataURL: String {
        "data:\(mediaType);base64," + jpegData.base64EncodedString()
    }

    /// Direct construction (tests, previews) — bypasses normalization.
    init(id: String, jpegData: Data, mediaType: String = "image/jpeg") {
        self.id = id
        self.jpegData = jpegData
        self.mediaType = mediaType
    }

    /// The inverse of `dataURL` — re-stage an image that has already been
    /// normalized (an unsent outbox message pulled back into the composer, a
    /// queued message reopened for editing), without paying for a
    /// decode/re-encode round trip.
    init?(dataURL: String) {
        guard dataURL.hasPrefix("data:"),
              let comma = dataURL.firstIndex(of: ","),
              let data = Data(
                  base64Encoded: String(dataURL[dataURL.index(after: comma)...])
              )
        else { return nil }
        let header = dataURL[dataURL.index(dataURL.startIndex, offsetBy: 5)..<comma]
        let declared = header.split(separator: ";").first.map(String.init) ?? ""
        self.id = UUID().uuidString
        self.jpegData = data
        self.mediaType = declared.hasPrefix("image/") ? declared : "image/jpeg"
    }

    init?(rawData: Data) {
        guard let jpeg = AttachedImage.normalizedJPEG(from: rawData) else {
            return nil
        }
        self.id = UUID().uuidString
        self.jpegData = jpeg
        self.mediaType = "image/jpeg"
    }

    /// Decode any picked image format, downscale to ≤2048px on the long edge
    /// (honoring EXIF orientation), and re-encode as JPEG. ImageIO only — the
    /// same code path works on iOS and macOS.
    private static func normalizedJPEG(
        from raw: Data, maxPixel: Int = 2048
    ) -> Data? {
        guard let source = CGImageSourceCreateWithData(raw as CFData, nil) else {
            return nil
        }
        let thumbOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(
            source, 0, thumbOptions as CFDictionary
        ) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            out, UTType.jpeg.identifier as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(
            dest, image,
            [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary
        )
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }
}
