import SwiftUI

struct PrSlackShareRequest: Identifiable {
    let id = UUID()
    let title: String
    let url: URL
    let sessionId: String
    let repo: String?
    let branch: String?
    let merged: Bool
    let walkthroughSummary: String?
    let suggestedScreenshot: String?
    var composerRequestId: String?
    var initialImages: [String] = []
    var preferredChannel: String? = nil
    var onComposerResolved: ((SlackComposeReceipt) -> Void)? = nil
}

enum ShippedChangeCopy {
    /// A first draft of the Slack message announcing a merged change, shown
    /// in the composer for the person to edit before sending.
    /// Repository-neutral: it reads the walkthrough summary when there is one,
    /// and otherwise turns the PR title from an instruction into an outcome.
    static func suggestion(title: String, summary: String?) -> String {
        if let summary, let prose = outcome(summary) { return prose }
        let clean = title
            .replacingOccurrences(of: #"^\[[^\]]+\]\s*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[.!?]+$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return "The update is now available." }
        if clean.range(of: #"\b(now|is|are|has|have|can)\b"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return sentence(clean)
        }
        let words = clean.split(separator: " ").map(String.init)
        let verb = words.first?.lowercased() ?? ""
        let object = words.dropFirst().joined(separator: " ")
        guard !object.isEmpty else { return sentence("\(clean) is now available") }
        switch verb {
        case "add", "create": return sentence("\(object) is now available")
        case "fix": return sentence("\(object) now works correctly")
        case "remove": return sentence("\(object) is now removed")
        case "improve", "polish", "redesign", "simplify":
            return sentence("\(object) is now improved")
        case "adopt", "change", "make", "replace", "update", "use":
            return sentence("\(object) is now updated")
        default: return sentence("\(clean) is now available")
        }
    }

    private static func outcome(_ markdown: String) -> String? {
        let lines = markdown
            .replacingOccurrences(of: #"!\[[^\]]*\]\([^)]*\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            .components(separatedBy: .newlines)
            .map {
                $0.replacingOccurrences(
                    of: #"^\s*(?:#{1,6}|[-*+]|\d+\.)\s+"#,
                    with: "",
                    options: .regularExpression
                )
                .replacingOccurrences(of: #"[*_`~]"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            .filter { !$0.isEmpty }
        for line in lines {
            let value = line
                .replacingOccurrences(
                    of: #"^Deployment is live\s*[\p{Pd}:]\s*"#,
                    with: "",
                    options: [.regularExpression, .caseInsensitive]
                )
                .replacingOccurrences(
                    of: #"^This change\s+"#,
                    with: "",
                    options: [.regularExpression, .caseInsensitive]
                )
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if value.count < 20
                || value.range(
                    of: #"^(done|pushed|merged|commit|tests?|verified|pr\s*#|updated and live)\b"#,
                    options: [.regularExpression, .caseInsensitive]
                ) != nil { continue }
            let first = firstSentence(value)
            if first.range(
                of: #"^we\s+(shipped|updated|added|changed|fixed)\b"#,
                options: [.regularExpression, .caseInsensitive]
            ) == nil {
                return sentence(first)
            }
        }
        return nil
    }

    private static func firstSentence(_ value: String) -> String {
        for delimiter in [". ", "! ", "? "] {
            if let range = value.range(of: delimiter) {
                return String(value[...range.lowerBound])
            }
        }
        return value
    }

    private static func sentence(_ value: String) -> String {
        let clean = value
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"[.!?]+$"#, with: "", options: .regularExpression)
        guard let first = clean.first else { return "" }
        return first.uppercased() + String(clean.dropFirst()) + "."
    }
}

enum ShippedChangeMedia {
    static func latestScreenshot(in entries: [TranscriptEntry]) -> String? {
        for entry in entries.reversed() {
            for source in (entry.featuredMedia ?? []).reversed() {
                if let path = localScreenshotPath(source) { return path }
            }
        }
        return nil
    }

    private static func localScreenshotPath(_ source: String) -> String? {
        let path: String
        if source.hasPrefix("/media?") {
            path = URLComponents(string: source)?.queryItems?
                .first { $0.name == "path" }?.value ?? ""
        } else {
            path = source
        }
        guard path.hasPrefix("/"),
              path.range(of: #"\.(png|jpe?g|gif|webp)$"#, options: [.regularExpression, .caseInsensitive]) != nil
        else { return nil }
        return path
    }
}

/// A deliberate Slack post: the description stays editable while the pull
/// request URL is fixed, so the shared message cannot lose its destination.
struct PrSlackShareSheet: View {
    let request: PrSlackShareRequest

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var description: String
    @State private var images: [AttachedImage] = []
    @State private var channels: [SlackAPI.Channel] = []
    @State private var selectedChannel = ""
    @State private var loading = true
    @State private var sending = false
    @State private var canUploadImages = true
    @State private var awaitingSlack = false
    @State private var errorText: String?
    #if os(iOS)
    @State private var consent: SafariLink?
    #endif
    @FocusState private var descriptionFocused: Bool

    init(request: PrSlackShareRequest) {
        self.request = request
        _description = State(initialValue: request.merged
            ? ShippedChangeCopy.suggestion(
                title: request.title,
                summary: request.walkthroughSummary
            )
            : request.title)
    }

    private var trimmedDescription: String {
        description.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSend: Bool {
        !sending && !loading && !selectedChannel.isEmpty
            && (!trimmedDescription.isEmpty || !images.isEmpty)
    }

    private var requiresReconnect: Bool {
        !images.isEmpty && !canUploadImages
    }

    /// A shipped change and a composer request post a message with pictures;
    /// a plain PR share posts a link, and has no Images section to paste into.
    private var acceptsImages: Bool {
        request.merged || request.composerRequestId != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $description)
                        .frame(minHeight: 110)
                        .focused($descriptionFocused)
                        .onChange(of: description) {
                            if description.count > 500 {
                                description = String(description.prefix(500))
                            }
                        }
                } header: {
                    Text("Description")
                } footer: {
                    Text(acceptsImages
                        ? "Keep it to 500 characters."
                        : "The GitHub link is added automatically.")
                }

                if acceptsImages {
                    Section("Images") {
                        if !images.isEmpty {
                            AttachedImagesRow(images: images) { image in
                                images.removeAll { $0.id == image.id }
                            }
                        }
                        AttachImagesButton(images: $images, maxCount: 10, systemImage: "plus")
                            .accessibilityLabel("Add images")
                    }
                }

                Section("Channel") {
                    if loading {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text("Loading channels")
                                .foregroundStyle(.secondary)
                        }
                    } else if channels.isEmpty {
                        Text("No Slack channels are configured.")
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Send to", selection: $selectedChannel) {
                            ForEach(channels) { channel in
                                Text("#\(channel.name)").tag(channel.id)
                            }
                        }
                    }
                }

                if request.composerRequestId == nil {
                    Section("Pull request") {
                        Link(destination: request.url) {
                            Text(request.url.absoluteString)
                                .lineLimit(2)
                        }
                    }
                }

                if let errorText {
                    Section {
                        Text(errorText).foregroundStyle(.red)
                    }
                }
            }
            // A screenshot is usually already on the clipboard when you come
            // to write this message, so Cmd+V attaches it rather than pasting
            // nothing into the description. On iOS the same modifier puts
            // Paste in the text field's own edit menu.
            .pastesImages(into: $images, maxCount: 10, when: acceptsImages)
            .navigationTitle("Share to Slack")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .topLeadingCompat) {
                    Button("Cancel") { cancel() }
                }
                ToolbarItem(placement: .topTrailingCompat) {
                    if sending || awaitingSlack {
                        ProgressView().controlSize(.small)
                    } else {
                        Button(requiresReconnect ? "Reconnect" : "Send") {
                            requiresReconnect ? reconnectSlack() : send()
                        }
                        .disabled(requiresReconnect ? sending : !canSend)
                    }
                }
            }
            .disabled(sending)
            .task {
                async let channelLoad: Void = loadChannels()
                async let imageLoad: Void = loadSuggestedImage()
                _ = await (channelLoad, imageLoad)
                loading = false
            }
            .task(id: awaitingSlack) {
                guard awaitingSlack else { return }
                for _ in 0..<24 {
                    try? await Task.sleep(for: .seconds(5))
                    if Task.isCancelled { return }
                    await loadChannels(focusDescription: false)
                    if canUploadImages {
                        awaitingSlack = false
                        #if os(iOS)
                        consent = nil
                        #endif
                        return
                    }
                }
                awaitingSlack = false
                errorText = "Slack access is still waiting for approval."
            }
        }
        .interactiveDismissDisabled(sending || request.composerRequestId != nil)
        #if os(iOS)
        .sheet(item: $consent) { link in SafariSheet(url: link.url) }
        #endif
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 440)
        #endif
    }

    private func loadChannels(focusDescription: Bool = true) async {
        do {
            let response: SlackAPI.ChannelsResponse
            if request.merged {
                response = try await SlackAPI.shippedChangeChannels(sessionId: request.sessionId)
            } else {
                response = try await SlackAPI.channels(sessionId: request.sessionId)
            }
            channels = response.channels
            canUploadImages = response.canUploadImages ?? true
            if !response.channels.contains(where: { $0.id == selectedChannel }) {
                let preferred = request.preferredChannel?.trimmingCharacters(in: .whitespacesAndNewlines)
                    .replacingOccurrences(of: "#", with: "")
                selectedChannel = response.channels.first {
                    $0.id == preferred || $0.name.caseInsensitiveCompare(preferred ?? "") == .orderedSame
                }?.id ?? (response.channels.contains { $0.id == response.defaultChannel }
                    ? response.defaultChannel ?? ""
                    : response.channels.first?.id ?? "")
            }
            if focusDescription { descriptionFocused = true }
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
        }
    }

    private func loadSuggestedImage() async {
        guard acceptsImages else { return }
        let paths = [request.suggestedScreenshot].compactMap { $0 } + request.initialImages
        var loaded: [AttachedImage] = []
        for path in paths.prefix(10) {
            guard let data = try? await OS1API.media(path: path),
                  let image = AttachedImage(rawData: data) else { continue }
            loaded.append(image)
        }
        images = loaded
    }

    private func send() {
        guard canSend else { return }
        Haptics.play(.send)
        sending = true
        errorText = nil
        descriptionFocused = false
        Task {
            do {
                if let composerRequestId = request.composerRequestId {
                    var screenshots: [String] = []
                    for (index, image) in images.enumerated() {
                        screenshots.append(try await SlackAPI.uploadImage(image, index: index + 1))
                    }
                    let response = try await SlackAPI.sendComposer(
                        sessionId: request.sessionId,
                        requestId: composerRequestId,
                        channelId: selectedChannel,
                        message: trimmedDescription,
                        screenshots: screenshots
                    )
                    request.onComposerResolved?(SlackComposeReceipt(
                        requestId: composerRequestId,
                        status: .sent,
                        channel: response.channel.map {
                            .init(id: $0.id, name: $0.name)
                        },
                        permalink: response.permalink
                    ))
                } else if request.merged {
                    var screenshots: [String] = []
                    for (index, image) in images.enumerated() {
                        screenshots.append(try await SlackAPI.uploadImage(image, index: index + 1))
                    }
                    _ = try await SlackAPI.shareShippedChange(
                        sessionId: request.sessionId,
                        repo: request.repo,
                        branch: request.branch,
                        channelId: selectedChannel,
                        message: trimmedDescription,
                        screenshots: screenshots
                    )
                } else {
                    try await SlackAPI.post(
                        channelId: selectedChannel,
                        text: "\(trimmedDescription)\n\(request.url.absoluteString)"
                    )
                }
                Haptics.play(.commit)
                dismiss()
            } catch {
                let message = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
                errorText = message
                if message.contains("Reconnect Slack") { canUploadImages = false }
                Haptics.play(.warn)
            }
            sending = false
        }
    }

    private func reconnectSlack() {
        errorText = nil
        Task {
            do {
                let started = try await SettingsAPI.startMcpOauth(name: "slack")
                guard let raw = started.url, let url = URL(string: raw) else {
                    errorText = "The server did not return a consent URL."
                    return
                }
                awaitingSlack = true
                #if os(iOS)
                if SafariLink.isWeb(url) { consent = SafariLink(url: url) }
                else { openURL(url) }
                #else
                openURL(url)
                #endif
            } catch {
                errorText = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }

    private func cancel() {
        guard let composerRequestId = request.composerRequestId else {
            dismiss()
            return
        }
        sending = true
        Task {
            do {
                try await SlackAPI.cancelComposer(
                    sessionId: request.sessionId,
                    requestId: composerRequestId
                )
                request.onComposerResolved?(SlackComposeReceipt(
                    requestId: composerRequestId,
                    status: .cancelled,
                    channel: nil,
                    permalink: nil
                ))
                dismiss()
            } catch {
                sending = false
                errorText = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }
}
