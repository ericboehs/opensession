import XCTest
@testable import OS1

/// Attaching a file to a Plain reply or note, on the two halves no screen
/// makes obvious: the wire shape the route insists on, and the budget rules
/// that decide whether the send is allowed to start at all.
///
/// The route (src/server/routes/plain.ts) is unusual enough to be worth
/// pinning — the bytes are the whole body rather than multipart, the file's
/// name arrives percent-encoded in a header, and each upload is STAMPED with
/// the mode it was made for, so a file uploaded for a reply is rejected once
/// the composer flips to a note.
final class SupportAttachmentWireTests: XCTestCase {
    func testUploadGoesToTheThreadsAttachmentRoute() {
        let target = OS1API.supportAttachmentUpload(
            threadId: "th_01KZX32SCT25RHTSR5Z9KVK9DY",
            fileName: "shot.png",
            isNote: false
        )
        XCTAssertEqual(
            target.path,
            "/api/plain/threads/th_01KZX32SCT25RHTSR5Z9KVK9DY/attachments"
        )
        XCTAssertEqual(target.headers["x-plain-kind"], "reply")
    }

    /// The mode is part of the UPLOAD, not just the send: the server refuses a
    /// note that carries a reply's attachment.
    func testUploadCarriesTheModeItWasMadeFor() {
        let note = OS1API.supportAttachmentUpload(
            threadId: "th_1",
            fileName: "shot.png",
            isNote: true
        )
        XCTAssertEqual(note.headers["x-plain-kind"], "note")
    }

    /// A header is ASCII and the server decodes it with `decodeURIComponent`,
    /// so anything but a letter or a digit has to go up as %XX — and has to
    /// come back out as the name the customer sees.
    func testFileNameTravelsPercentEncoded() {
        let name = "Skärm bild, 100% (2).png"
        let header = OS1API.supportAttachmentUpload(
            threadId: "th_1",
            fileName: name,
            isNote: false
        ).headers["x-file-name"]
        XCTAssertEqual(header?.removingPercentEncoding, name)
        XCTAssertEqual(header?.contains(where: { !$0.isASCII }), false)
        XCTAssertFalse(header?.contains(" ") ?? true)
    }

    /// The ids ride WITH the message rather than on a request of their own —
    /// the same order as the web's `PlainThreadPanel`, and what makes a
    /// half-uploaded attachment impossible to send.
    func testReplyBodyCarriesTheAttachmentIds() {
        let body = OS1API.supportReplyBody(
            text: "Here's the screenshot.",
            isNote: false,
            user: "Michiel",
            attachmentIds: ["att_1", "att_2"]
        )
        XCTAssertEqual(body["kind"] as? String, "reply")
        XCTAssertEqual(body["attachmentIds"] as? [String], ["att_1", "att_2"])
        XCTAssertEqual(body["user"] as? String, "Michiel")
        // The route reads `attachmentIds` off the JSON, so it must survive
        // serialization as an array rather than as some Foundation box.
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: body))
    }

    /// A message with no files still sends, and still says so explicitly: the
    /// route treats a missing key and an empty list the same, but a client
    /// that omitted it would be one refactor away from omitting a real one.
    func testReplyBodyWithoutFilesIsAnEmptyList() {
        let body = OS1API.supportReplyBody(
            text: "Looking into it.",
            isNote: true,
            user: "",
            attachmentIds: []
        )
        XCTAssertEqual(body["kind"] as? String, "note")
        XCTAssertEqual(body["attachmentIds"] as? [String], [])
        // No name means the server signs it however it likes; sending an
        // empty one would attribute the note to nobody.
        XCTAssertNil(body["user"])
    }
}

/// The composer's own rules, which decide whether an upload is even
/// attempted. Everything here is refused BEFORE the first byte goes up: a set
/// that can't be sent shouldn't leave half its files staged on the thread.
@MainActor
final class SupportComposerAttachmentTests: XCTestCase {
    private func draft(_ name: String, bytes: Int) -> SupportAttachmentDraft {
        SupportAttachmentDraft(
            fileName: name,
            mimeType: "image/jpeg",
            data: Data(count: bytes)
        )
    }

    /// The split the web enforces too: Plain gives an internal note far more
    /// room than a customer-facing reply.
    func testTheTwoModesHaveDifferentBudgets() {
        XCTAssertEqual(SupportAttachmentDraft.maxTotalBytes(isNote: false), 6 * 1024 * 1024)
        XCTAssertEqual(SupportAttachmentDraft.maxTotalBytes(isNote: true), 50 * 1024 * 1024)
    }

    /// 7 MB is a fine note and an impossible reply, and switching the mode is
    /// the fix — so the message says which mode would take it.
    func testASetOverTheReplyBudgetFitsANote() {
        let model = SupportThreadModel(threadId: "th_1")
        model.stage([draft("screen.jpg", bytes: 7 * 1024 * 1024)])
        model.draft = "Here you go"

        XCTAssertNotNil(model.overBudget)
        XCTAssertEqual(model.overBudget?.contains("6 MB"), true)
        XCTAssertEqual(model.overBudget?.contains("50 MB"), true)
        XCTAssertFalse(model.canSend)

        model.isNoteMode = true
        XCTAssertNil(model.overBudget)
        XCTAssertTrue(model.canSend)
    }

    /// Plain caps a single file at 25 MB whatever the mode is, so it is
    /// refused at the picker rather than after a minute of uploading — by
    /// name, because a picker that silently drops a file is worse than one
    /// that says no.
    func testAFileOverTwentyFiveMegabytesIsRefusedByName() {
        let model = SupportThreadModel(threadId: "th_1")
        let problem = model.stage([
            draft("huge.jpg", bytes: 26 * 1024 * 1024),
            draft("fine.jpg", bytes: 1024),
        ])
        XCTAssertEqual(problem?.contains("huge.jpg"), true)
        // The rest of the pick still lands: one bad file doesn't cancel the
        // others.
        XCTAssertEqual(model.attachments.map(\.fileName), ["fine.jpg"])
        if case .failedUpload(let message) = model.sending {
            XCTAssertEqual(message.contains("25 MB"), true)
        } else {
            XCTFail("an oversized file should surface in the composer")
        }
    }

    func testAtMostTwentyFiles() {
        let model = SupportThreadModel(threadId: "th_1")
        model.stage((1...25).map { draft("f\($0).jpg", bytes: 16) })
        XCTAssertEqual(model.attachments.count, SupportAttachmentDraft.maxCount)
        XCTAssertEqual(model.attachmentSlots, 0)
    }

    /// Two photos picked in the same second carry the same generated name;
    /// Plain would show a pair of identical rows.
    func testDuplicateNamesAreDisambiguated() {
        let model = SupportThreadModel(threadId: "th_1")
        model.stage([draft("Image.jpg", bytes: 16), draft("Image.jpg", bytes: 16)])
        XCTAssertEqual(model.attachments.map(\.fileName), ["Image.jpg", "Image (2).jpg"])
    }

    /// A support reply is sometimes nothing but a screenshot.
    func testAFileAloneIsSendable() {
        let model = SupportThreadModel(threadId: "th_1")
        XCTAssertFalse(model.canSend)
        model.stage([draft("shot.jpg", bytes: 2048)])
        XCTAssertTrue(model.canSend)
        model.removeAttachment(model.attachments[0])
        XCTAssertFalse(model.canSend)
    }

    /// The picked bytes are what gets uploaded, and the name is what the
    /// customer sees in Plain — a photo from the library arrives without one.
    func testAPickedPhotoIsNamedForWhenItWasTaken() {
        let taken = Date(timeIntervalSince1970: 1_770_000_000)
        let file = SupportAttachmentDraft(
            image: AttachedImage(id: "a", jpegData: Data(count: 8), mediaType: "image/jpeg"),
            takenAt: taken
        )
        XCTAssertTrue(file.fileName.hasPrefix("Image "))
        XCTAssertTrue(file.fileName.hasSuffix(".jpg"))
        XCTAssertTrue(file.isImage)
        XCTAssertEqual(file.data.count, 8)
    }
}
