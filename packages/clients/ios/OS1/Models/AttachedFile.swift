import Foundation
import UniformTypeIdentifiers

/// One non-image file staged for a composer. The bytes are kept only until the
/// server's `/api/upload` route returns a confined path; the create request then
/// carries that small path reference instead of putting base64 in JSON.
struct AttachedFile: Identifiable, Equatable, Sendable {
    static let maxBytes = 50 * 1024 * 1024

    let id: String
    let name: String
    let mediaType: String
    let data: Data?
    let path: String?

    init(
        id: String = UUID().uuidString,
        name: String,
        mediaType: String = "application/octet-stream",
        data: Data? = nil,
        path: String? = nil
    ) {
        self.id = id
        self.name = name
        self.mediaType = mediaType
        self.data = data
        self.path = path
    }

    var isStaged: Bool { path?.isEmpty == false }

    /// The server's composer file shape. Only staged paths are sent: accepting
    /// an unstaged item would make the session start without the file the chip
    /// promised was attached.
    var wireValue: [String: String]? {
        guard let path, !path.isEmpty else { return nil }
        return ["name": name, "type": mediaType, "path": path]
    }

    func staged(name stagedName: String, path: String) -> AttachedFile {
        AttachedFile(
            id: id,
            name: stagedName.isEmpty ? name : stagedName,
            mediaType: mediaType,
            path: path
        )
    }
}

/// The result of adopting a URL handed to the app by iOS. Images stay on the
/// vision channel; every other regular file uses the server's file channel.
enum ImportedComposerAttachment: Sendable {
    case image(AttachedImage)
    case file(AttachedFile)

    static func load(from url: URL) throws -> ImportedComposerAttachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        let values = try url.resourceValues(forKeys: [
            .isRegularFileKey, .fileSizeKey, .contentTypeKey,
        ])
        guard values.isRegularFile == true else {
            throw ComposerAttachmentImportError.notAFile
        }
        if let size = values.fileSize, size > AttachedFile.maxBytes {
            throw ComposerAttachmentImportError.tooLarge(name: url.lastPathComponent)
        }

        let data = try Data(contentsOf: url)
        guard !data.isEmpty else { throw ComposerAttachmentImportError.empty }
        guard data.count <= AttachedFile.maxBytes else {
            throw ComposerAttachmentImportError.tooLarge(name: url.lastPathComponent)
        }

        let type = values.contentType
            ?? UTType(filenameExtension: url.pathExtension)
        if type?.conforms(to: .image) == true,
           let image = AttachedImage(rawData: data) {
            return .image(image)
        }
        return .file(AttachedFile(
            name: url.lastPathComponent.isEmpty ? "file" : url.lastPathComponent,
            mediaType: type?.preferredMIMEType ?? "application/octet-stream",
            data: data
        ))
    }
}

enum ComposerAttachmentImportError: LocalizedError {
    case notAFile
    case empty
    case tooLarge(name: String)

    var errorDescription: String? {
        switch self {
        case .notAFile:
            "Choose a file, not a folder."
        case .empty:
            "This file is empty."
        case .tooLarge(let name):
            "\(name) is over the 50 MB attachment limit."
        }
    }
}
