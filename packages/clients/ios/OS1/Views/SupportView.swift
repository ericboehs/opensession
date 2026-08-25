import SwiftUI
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

/// The Plain queue as a panel — pushed on the phone, the detail column on the
/// Mac. Not a sheet: support is a place in the app, and a modal would cover the
/// list you came from and refuse to sit beside anything.
///
/// Two levels: the Todo queue in Plain's four priority lanes, and one ticket.
/// The triage loop is the whole point of carrying this in a pocket — read what
/// the customer said, answer it or leave the team a note, then move it out of
/// the queue.
///
/// What the web has and this deliberately doesn't (yet): assign, labels,
/// priority, rename, mark-spam, and the triage hand-off that spawns a session.
/// Each needs its own picker; spam is customer-wide and destructive enough to
/// deserve a considered flow rather than a v1 sheet.
struct SupportQueueView: View {
    @Bindable var model: SupportQueueModel
    /// Opening a ticket is the container's call: the phone pushes it onto the
    /// same stack this view sits on, the Mac swaps the detail column.
    var onOpen: (SupportThreadSummary) -> Void

    var body: some View {
        queue
            .navigationTitle("Support")
            .inlineTitleBarCompat()
            .task { await model.load() }
    }

    @ViewBuilder
    private var queue: some View {
        if model.isLoading {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.threads.isEmpty {
            ListPlaceholder(
                symbol: "tray",
                title: model.errorText == nil ? "Inbox zero" : "Couldn't load the queue",
                message: model.errorText ?? "No tickets are waiting in Plain."
            ) {
                Button("Refresh") { Task { await model.load() } }
                    .buttonStyle(PlaceholderActionStyle())
            }
        } else {
            List {
                ForEach(model.lanes, id: \.priority) { lane in
                    Section {
                        ForEach(lane.threads) { row in
                            Button { onOpen(row) } label: { SupportRow(row: row) }
                                .buttonStyle(.plain)
                                #if os(iOS)
                                .listRowInsets(EdgeInsets(
                                    top: 2, leading: 20, bottom: 2, trailing: 20
                                ))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                                #endif
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Text(lane.priority.label)
                            Text("\(lane.threads.count)")
                                .foregroundStyle(OS1VisualStyle.textFaint)
                        }
                    }
                }
            }
            #if os(iOS)
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 8)
            .scrollContentBackground(.hidden)
            .background(OS1VisualStyle.background)
            .listSectionSpacing(10)
            .contentMargins(.top, 4, for: .scrollContent)
            #endif
            .refreshable { await model.load() }
        }
    }
}

private struct SupportRow: View {
    let row: SupportThreadSummary

    var body: some View {
        HStack(spacing: 9) {
            Circle()
                .fill(priorityColor)
                .frame(width: 8, height: 8)
                .frame(width: 22, height: 22)
            Text(row.rowLabel)
                #if os(iOS)
                .font(.callout.weight(.medium))
                .foregroundStyle(OS1VisualStyle.textDim)
                #else
                .font(.body)
                .foregroundStyle(.primary)
                #endif
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        #if os(iOS)
        .padding(.vertical, 13)
        #else
        .padding(.vertical, 3)
        #endif
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.rowLabel)
        .accessibilityValue(row.lane.label)
    }

    private var priorityColor: Color {
        switch row.lane {
        case .urgent: OS1VisualStyle.red
        case .high: OS1VisualStyle.yellow
        case .normal: OS1VisualStyle.blue
        case .low: OS1VisualStyle.textFaint
        }
    }
}

/// One ticket: the conversation, then the composer.
struct SupportThreadView: View {
    let row: SupportThreadSummary
    /// Called when the ticket leaves the queue, so the list can drop the row
    /// instead of showing it for the length of the server's cache.
    var onLeftQueue: () -> Void = {}

    @State private var model: SupportThreadModel

    init(row: SupportThreadSummary, onLeftQueue: @escaping () -> Void = {}) {
        self.row = row
        self.onLeftQueue = onLeftQueue
        _model = State(initialValue: SupportThreadModel(threadId: row.id))
    }

    var body: some View {
        VStack(spacing: 0) {
            if model.isLoading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                timeline
            }
            SupportComposer(model: model)
        }
        .background(OS1VisualStyle.background)
        .navigationTitle(model.thread?.customerLabel ?? row.customerLabel)
        .inlineTitleBarCompat()
        .toolbar {
            ToolbarItem(placement: .topTrailingCompat) { statusMenu }
        }
        .task {
            await model.load()
            model.startPolling()
        }
        .onDisappear {
            model.stopPolling()
            if model.statusChanged { onLeftQueue() }
        }
    }

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let thread = model.thread {
                        header(thread)
                        ForEach(thread.entries ?? []) { entry in
                            SupportEntryRow(entry: entry)
                                .id(entry.id)
                        }
                    } else if let error = model.errorText {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.redInk)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .onChange(of: model.thread?.entries?.count ?? 0) {
                // Newest last, and a poll that lands while you're reading
                // shouldn't move you — only jump for arrivals at the bottom.
                if let last = model.thread?.entries?.last?.id {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last, anchor: .bottom)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func header(_ thread: SupportThread) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title = thread.title?.nilIfBlank {
                Text(title)
                    .font(.headline)
            }
            HStack(spacing: 6) {
                if let email = thread.customer?.email?.nilIfBlank {
                    Text(email)
                }
                if let status = thread.status?.nilIfBlank {
                    Text("· \(status.capitalized)")
                }
            }
            .font(.footnote)
            .foregroundStyle(OS1VisualStyle.textDim)
            if thread.awaitingFirstResponse == true {
                Text("Waiting for a first reply")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.yellowInk)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var statusMenu: some View {
        Menu {
            if model.thread?.isDone == true {
                Button("Reopen") { Task { await model.setStatus("todo") } }
            } else {
                Button("Mark done") { Task { await model.setStatus("done") } }
                if model.thread?.isSnoozed == true {
                    Button("Unsnooze") { Task { await model.setStatus("todo") } }
                }
                Menu("Snooze") {
                    // The web's own set, in the same order.
                    snooze("1 hour", 3600)
                    snooze("4 hours", 4 * 3600)
                    snooze("1 day", 24 * 3600)
                    snooze("3 days", 3 * 24 * 3600)
                    snooze("1 week", 7 * 24 * 3600)
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .foregroundStyle(OS1VisualStyle.text)
        }
        .accessibilityLabel("Ticket actions")
    }

    private func snooze(_ label: String, _ seconds: Int) -> some View {
        Button(label) {
            Task { await model.setStatus("snoozed", durationSeconds: seconds) }
        }
    }
}

/// One timeline entry: the customer on the left, us on the right, and a note
/// full-width in between — a note is the team talking to itself, not a side of
/// the conversation.
private struct SupportEntryRow: View {
    let entry: SupportEntry

    var body: some View {
        if entry.isNote {
            note
        } else {
            message
        }
    }

    private var note: some View {
        let unpicked = SupportNote.unpick(entry.text)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("Note")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        OS1VisualStyle.yellow.opacity(0.22),
                        in: Capsule()
                    )
                // The server posts every note under the machine user with the
                // author's name glued to the front, so the name here comes out
                // of the text rather than off the entry.
                Text(unpicked.author ?? entry.actorName ?? "Someone")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.textDim)
                Spacer(minLength: 4)
                timestamp
            }
            // Notes are the one entry kind written in markdown; the rest are
            // plain text, including email (the server only ever fetches an
            // email's text part).
            MarkdownBody(unpicked.body)
            SupportAttachments(attachments: entry.attachments ?? [])
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            OS1VisualStyle.yellow.opacity(0.10),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }

    private var message: some View {
        HStack {
            if !entry.isFromCustomer { Spacer(minLength: 40) }
            VStack(alignment: entry.isFromCustomer ? .leading : .trailing, spacing: 4) {
                HStack(spacing: 6) {
                    Text(entry.actorName ?? (entry.isFromCustomer ? "Customer" : "Support"))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.textDim)
                    timestamp
                }
                if let subject = entry.subject?.nilIfBlank {
                    Text(subject)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                if !entry.text.isEmpty {
                    Text(entry.text)
                        .font(.body)
                        .textSelection(.enabled)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(
                            entry.isFromCustomer
                                ? OS1VisualStyle.panel
                                : OS1VisualStyle.userMessage,
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                        )
                }
                SupportAttachments(attachments: entry.attachments ?? [])
            }
            if entry.isFromCustomer { Spacer(minLength: 40) }
        }
    }

    @ViewBuilder
    private var timestamp: some View {
        if let date = entry.date {
            Text(date, format: .relative(presentation: .named))
                .font(.caption2)
                .foregroundStyle(OS1VisualStyle.textFaint)
        }
    }
}

/// Attachments, inline where they're pictures. A support message is sometimes
/// nothing but a screenshot — dropping those would render the report empty.
private struct SupportAttachments: View {
    let attachments: [SupportEntry.Attachment]

    /// Every picture in the message, so opening one pages through the rest: a
    /// visual bug report is usually several shots of the same screen, and a
    /// viewer that only ever shows the one you tapped makes you close it to
    /// see the next.
    private var gallery: [PreviewImage] {
        attachments.filter(\.isImage).map { attachment in
            PreviewImage(
                id: attachment.id,
                source: .support(id: attachment.id),
                label: attachment.fileName?.nilIfBlank
            )
        }
    }

    var body: some View {
        if !attachments.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(attachments) { attachment in
                    if attachment.isImage {
                        SupportImage(
                            attachment: attachment,
                            gallery: gallery,
                            galleryIndex: gallery.firstIndex { $0.id == attachment.id } ?? 0
                        )
                    } else {
                        Label(
                            [attachment.fileName?.nilIfBlank ?? "Attachment",
                             attachment.sizeLabel]
                                .compactMap { $0 }
                                .joined(separator: " · "),
                            systemImage: "paperclip"
                        )
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textDim)
                    }
                }
            }
        }
    }
}

/// One image attachment. A tap opens it in the same zoomable full-screen
/// viewer the transcript's pictures use — inline it is capped at 220pt, which
/// is a thumbnail of a screenshot: the thing the customer is pointing at is
/// unreadable until it fills the screen. (The web makes the same picture a
/// link to the full-size file.)
///
/// Fetched by hand rather than through `AsyncImage`: the proxy needs the app's
/// bearer token, and an image view's own subresource load doesn't carry it —
/// the same reason the assets viewer fetches its bytes itself.
private struct SupportImage: View {
    let attachment: SupportEntry.Attachment
    /// The message's other pictures, and where this one sits among them.
    var gallery: [PreviewImage] = []
    var galleryIndex: Int = 0

    @State private var data: Data?
    @State private var failed = false
    #if os(iOS)
    @State private var previewing = false

    /// Falls back to the bytes already in hand, so a picture is never a
    /// button that opens an empty viewer.
    private var items: [PreviewImage] {
        gallery.isEmpty
            ? [PreviewImage(
                id: attachment.id,
                source: .support(id: attachment.id),
                label: attachment.fileName?.nilIfBlank
            )]
            : gallery
    }
    #endif

    var body: some View {
        Group {
            if let data, let image = decoded(data) {
                picture(image)
            } else if failed {
                Label(
                    attachment.fileName?.nilIfBlank ?? "Attachment",
                    systemImage: "photo"
                )
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textDim)
            } else {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(OS1VisualStyle.hover)
                    .frame(height: 120)
            }
        }
        .task {
            guard data == nil else { return }
            do {
                data = try await OS1API.supportAttachment(id: attachment.id)
            } catch {
                failed = true
            }
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $previewing) {
            FullScreenImagePreview(items: items, index: galleryIndex)
        }
        #endif
    }

    /// The picture at its inline size, tappable into the viewer on iOS. The
    /// Mac has no full-screen cover to open, so there it stays a picture.
    @ViewBuilder
    private func picture(_ image: Image) -> some View {
        let inline = image
            .resizable()
            .scaledToFit()
            .frame(maxHeight: 220)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        #if os(iOS)
        Button {
            previewing = true
        } label: {
            inline
        }
        .buttonStyle(.plain)
        .accessibilityLabel(attachment.fileName?.nilIfBlank ?? "Attached image")
        .accessibilityHint("Shows the attachment full screen")
        #else
        inline
        #endif
    }

    private func decoded(_ data: Data) -> Image? {
        #if canImport(UIKit)
        UIImage(data: data).map(Image.init(uiImage:))
        #else
        NSImage(data: data).map(Image.init(nsImage:))
        #endif
    }
}

/// Reply or note, and the send.
///
/// Its own view struct because the draft is per-keystroke state: read here and
/// nowhere else, so typing doesn't re-evaluate the timeline above it.
private struct SupportComposer: View {
    @Bindable var model: SupportThreadModel
    @FocusState private var focused: Bool
    /// What the shared "+" menu picks into. Drained into the model on every
    /// change, so this holds a picture for one run loop and the model stays
    /// the only list of what is staged.
    @State private var picked: [AttachedImage] = []
    @State private var browsingFiles = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Kind", selection: $model.isNoteMode) {
                Text("Reply").tag(false)
                Text("Internal note").tag(true)
            }
            .pickerStyle(.segmented)

            if !model.attachments.isEmpty {
                SupportAttachmentsRow(
                    attachments: model.attachments,
                    onRemove: { model.removeAttachment($0) }
                )
            }

            HStack(alignment: .bottom, spacing: 8) {
                ComposerAddMenu(
                    images: $picked,
                    onBrowseFiles: { browsingFiles = true },
                    maxCount: model.attachmentSlots
                )
                .disabled(model.sending == .sending || model.attachmentSlots == 0)

                TextField(placeholder, text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused($focused)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        OS1VisualStyle.panel,
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                    )
                Button {
                    Task { await model.send() }
                } label: {
                    if model.sending == .sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up")
                            .foregroundStyle(OS1VisualStyle.onAccent)
                    }
                }
                #if os(iOS)
                .frame(width: 44, height: 44)
                #else
                .frame(width: 34, height: 34)
                #endif
                .background(
                    model.canSend ? OS1VisualStyle.accent : OS1VisualStyle.hover,
                    in: Circle()
                )
                // One send at a time, and never an automatic retry: a reply is
                // an email to a customer and the route has no idempotency key,
                // so a second attempt is a second email.
                .disabled(!model.canSend)
                .buttonStyle(.plain)
                .accessibilityLabel(model.isNoteMode ? "Add note" : "Send reply")
            }

            Text(footnote)
                .font(.footnote)
                .foregroundStyle(footnoteColor)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
        // A customer reply is the one send in the app that leaves the
        // building, so it reports the OUTCOME rather than the tap: the round
        // trip through Plain is long enough that a tap-time tick would be
        // reassurance about something that hadn't happened yet.
        .haptic(trigger: model.sending) { previous, sending in
            guard previous != sending else { return nil }
            switch sending {
            case .sent: return .commit
            case .failed, .failedUpload: return .warn
            case .idle, .sending: return nil
            }
        }
        // The "+" appends to its own binding; anything that lands there is a
        // picked picture on its way into the staged list.
        .onChange(of: picked) {
            guard !picked.isEmpty else { return }
            let images = picked
            picked = []
            model.stage(images.map { SupportAttachmentDraft(image: $0) })
        }
        .fileImporter(
            isPresented: $browsingFiles,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            var files: [SupportAttachmentDraft] = []
            for url in urls.prefix(model.attachmentSlots) {
                // The picked file is only readable inside this scope, so the
                // bytes have to be taken now rather than kept as a URL.
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { continue }
                files.append(
                    SupportAttachmentDraft(
                        fileName: url.lastPathComponent,
                        mimeType: UTType(filenameExtension: url.pathExtension)?
                            .preferredMIMEType ?? "application/octet-stream",
                        data: data
                    )
                )
            }
            model.stage(files)
        }
    }

    private var placeholder: String {
        model.isNoteMode
            ? "Internal note for the team (English)…"
            : "Reply to \(model.thread?.customerLabel ?? "the customer") — sent via Plain…"
    }

    /// Says who the customer will see it from, and afterwards what actually
    /// happened: a reply falls back to the workspace bot when the sender has
    /// no Plain grant of their own, and that changes the name on the email.
    private var footnote: String {
        switch model.sending {
        case .failed(let message):
            return "Not sent: \(message). Check Plain before sending again."
        // Nothing left the building, so it says what to fix instead of
        // sending you to Plain to check.
        case .failedUpload(let message):
            return message
        case .sent(let asUser, let wasNote):
            if wasNote { return "Note added." }
            return asUser
                ? "Sent as you."
                : "Sent — as the workspace bot, not your Plain account."
        case .sending:
            if !model.attachments.isEmpty {
                return model.isNoteMode ? "Uploading and adding note…" : "Uploading and sending…"
            }
            return model.isNoteMode ? "Adding note…" : "Sending…"
        case .idle:
            // The size split is the one thing about attachments you can't
            // guess, so an oversized set says so before you tap send.
            if let overBudget = model.overBudget { return overBudget }
            let me = ServerConfig.shared.userName
            if model.isNoteMode {
                return "Only the team sees this."
            }
            return me.isEmpty
                ? "Sent via Plain."
                : "Sent via Plain, signed \"\(me)\"."
        }
    }

    private var footnoteColor: Color {
        switch model.sending {
        case .failed, .failedUpload: return OS1VisualStyle.redInk
        case .idle: return model.overBudget == nil
            ? OS1VisualStyle.textFaint
            : OS1VisualStyle.redInk
        default: return OS1VisualStyle.textFaint
        }
    }
}

/// The files waiting to go with the next message, as the session composer
/// shows its staged images: a thumbnail with a ✕ on it. A support attachment
/// isn't always a picture, so anything else gets a tile with its name and size
/// — which is what you check before sending a log to a customer.
private struct SupportAttachmentsRow: View {
    let attachments: [SupportAttachmentDraft]
    let onRemove: (SupportAttachmentDraft) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        tile(attachment)
                        Button {
                            onRemove(attachment)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 15))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.6))
                        }
                        .buttonStyle(.plain)
                        .padding(2)
                        .accessibilityLabel("Remove \(attachment.fileName)")
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder
    private func tile(_ attachment: SupportAttachmentDraft) -> some View {
        if attachment.isImage {
            DataImage(data: attachment.data)
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityLabel(attachment.fileName)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Image(systemName: "doc")
                    .font(.system(size: 15))
                    .foregroundStyle(OS1VisualStyle.textDim)
                Text(attachment.fileName)
                    .font(.caption2)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(attachment.sizeLabel)
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textFaint)
            }
            .frame(width: 104, height: 56, alignment: .leading)
            .padding(.horizontal, 8)
            .background(
                OS1VisualStyle.panel,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(attachment.fileName), \(attachment.sizeLabel)")
        }
    }
}
