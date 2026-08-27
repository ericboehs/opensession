import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// One image attached to a message or new-session prompt, normalized at pick
/// time: downscaled to the vision path's useful size and re-encoded as JPEG so
/// a 12 MP camera photo doesn't ride the WebSocket at 40 MB of base64.
struct AttachedImage: Identifiable, Equatable, Sendable {
    private static let serverMediaTypes = [
        "image/png", "image/jpeg", "image/gif", "image/webp",
    ]

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

    /// Return a data URL the server can stage. Ordinary JPEG/PNG/GIF/WebP
    /// images stay byte-for-byte identical; older HEIC/other image messages
    /// are converted once at the transport boundary.
    static func serverDataURL(_ dataURL: String) -> String? {
        guard let comma = dataURL.firstIndex(of: ","), dataURL.hasPrefix("data:")
        else { return nil }
        let header = dataURL[dataURL.index(dataURL.startIndex, offsetBy: 5)..<comma]
        let parts = header.split(separator: ";")
        guard parts.count == 2, parts[1] == "base64",
              dataURL.index(after: comma) < dataURL.endIndex
        else { return nil }
        let declared = String(parts[0])
        if serverMediaTypes.contains(declared) { return dataURL }
        return AttachedImage(dataURL: dataURL)?.dataURL
    }

    /// The inverse of `dataURL` — re-stage an image that has already been
    /// normalized (an unsent outbox message pulled back into the composer, a
    /// queued message reopened for editing). Formats the server can stage keep
    /// their original bytes; older HEIC/other image messages are converted to
    /// JPEG so retrying one cannot wedge the durable outbox forever.
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
        if Self.serverMediaTypes.contains(declared) {
            self.jpegData = data
            self.mediaType = declared
        } else {
            guard declared.hasPrefix("image/"),
                  let jpeg = Self.normalizedJPEG(from: data)
            else { return nil }
            self.jpegData = jpeg
            self.mediaType = "image/jpeg"
        }
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
