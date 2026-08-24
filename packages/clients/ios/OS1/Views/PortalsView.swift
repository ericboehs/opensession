import SwiftUI

#if os(iOS)
/// The services this session exposes, one level deeper than the conversation.
///
/// A phone keeps the two things you want when you are away from a desk: look
/// at a service that is up, and get one that isn't back. A live row opens in
/// the browser sheet over the session, the same as a link in the transcript;
/// a managed row swipes for stop and restart; and a repository's declared
/// starter asks the agent to bring the service up. The rest of the web's
/// panel is supervision, and it stays where a person can watch it.
///
/// Reading this list never wakes a sleeping sandbox. The server answers one
/// from a cached snapshot with no URLs and no starters in it, and nothing
/// here asks for more. Restarting does wake one, because a person named the
/// portal and confirmed it.
///
/// Stop and restart are swipe actions rather than a menu: the row's tap is
/// already spoken for by "open this", the list is a real `List`, and SwiftUI
/// publishes swipe actions to VoiceOver as row actions without extra work. A
/// menu would need its own control on every row, which is the desktop panel's
/// job, not a phone's.
struct PortalsListView: View {
    let sessionId: String

    @State private var status: PortalStatus?
    @State private var loading = true
    @State private var loadFailed = false
    /// The portal being looked at, over this list.
    @State private var openPortal: SafariLink?
    /// The action the server is working on, by service key. One at a time:
    /// the row it belongs to shows it, and the others stay swipeable.
    @State private var working: [String: PortalAction] = [:]
    /// An action waiting for a yes.
    @State private var confirming: PortalActionRequest?
    @State private var failure: PortalFailure?
    /// Starters already asked for, so the button can say so.
    @State private var asked: Set<String> = []

    private var services: [PortalService] { status?.services ?? [] }
    private var recipes: [PortalRecipe] { status?.startableRecipes ?? [] }

    var body: some View {
        Group {
            if loading && status == nil {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if loadFailed && status == nil {
                failedPlaceholder
            } else if services.isEmpty && recipes.isEmpty {
                emptyPlaceholder
            } else {
                portalList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background)
        .navigationTitle("Portals")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await load() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .sheet(item: $openPortal) { link in
            SafariSheet(url: link.url)
        }
        .confirmationDialog(
            confirming?.title ?? "",
            isPresented: Binding(
                get: { confirming != nil },
                set: { if !$0 { confirming = nil } }
            ),
            titleVisibility: .visible,
            presenting: confirming
        ) { request in
            Button(
                request.confirmLabel,
                role: request.action == .stop ? ButtonRole.destructive : nil
            ) {
                Task { await perform(request.action, on: request.service) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { request in
            Text(request.message)
        }
        .alert(
            failure?.title ?? "",
            isPresented: Binding(
                get: { failure != nil },
                set: { if !$0 { failure = nil } }
            ),
            presenting: failure
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { failure in
            Text(failure.message)
        }
        .task(id: sessionId) { await load() }
    }

    // MARK: - The list

    private var portalList: some View {
        List {
            if !services.isEmpty {
                Section {
                    ForEach(services) { service in
                        row(for: service)
                    }
                } header: {
                    Text(liveHeading)
                } footer: {
                    Text(footerText)
                }
            }
            if !recipes.isEmpty {
                Section {
                    ForEach(recipes) { recipe in
                        RecipeRow(
                            recipe: recipe,
                            asked: asked.contains(recipe.id),
                            action: { ask(recipe) }
                        )
                    }
                } header: {
                    Text("Can be started")
                } footer: {
                    Text("Asking sends a message to this session. The agent starts the service and reports back.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
        .refreshable { await load() }
    }

    @ViewBuilder
    private func row(for service: PortalService) -> some View {
        let inFlight = working[service.key]
        Group {
            if let url = service.openURL, inFlight == nil {
                Button {
                    openPortal = SafariLink(url: url)
                } label: {
                    PortalRow(service: service, opens: true, working: nil)
                }
                .buttonStyle(.plain)
            } else {
                PortalRow(service: service, opens: false, working: inFlight)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if service.canStop {
                Button(role: .destructive) {
                    request(.stop, on: service)
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
                .disabled(inFlight != nil)
            }
            if service.canRestart {
                Button {
                    request(.restart, on: service)
                } label: {
                    Label("Restart", systemImage: "arrow.clockwise")
                }
                .tint(OS1VisualStyle.blue)
                .disabled(inFlight != nil)
            }
        }
    }

    private var liveHeading: String {
        let live = status?.liveCount ?? 0
        return live == 1 ? "1 live portal" : "\(live) live portals"
    }

    private var footerText: String {
        var lines = ["Services this session exposes. Tap a live one to open it."]
        if services.contains(where: \.managed) {
            lines.append("Swipe a supervised one to stop or restart it.")
        }
        if services.contains(where: { $0.display == .sleeping }) {
            lines.append("A sleeping sandbox stays asleep until you restart a portal in it.")
        }
        return lines.joined(separator: " ")
    }

    // MARK: - Placeholders

    private var emptyPlaceholder: some View {
        ListPlaceholder(
            symbol: "globe",
            title: status?.starting == true ? "Starting services…" : "No portals",
            message: status?.starting == true
                ? "They appear here as soon as their ports are ready."
                : "A dev server, a docs site, a dashboard: whatever this "
                    + "session puts on a port shows up here."
        ) {
            EmptyView()
        }
    }

    private var failedPlaceholder: some View {
        ListPlaceholder(
            symbol: "exclamationmark.triangle",
            title: "Couldn't load portals",
            message: "The server didn't answer for this session's services."
        ) {
            Button("Try again") { Task { await load() } }
                .buttonStyle(PlaceholderActionStyle())
        }
    }

    // MARK: - Acting

    /// Ask first when the action can't be undone by looking again, otherwise
    /// run it. Restarting a portal that is already up is the one-tap fix this
    /// screen exists for, and a dialog in front of it would undo the point.
    private func request(_ action: PortalAction, on service: PortalService) {
        guard working[service.key] == nil else { return }
        if service.needsConfirmation(for: action) {
            confirming = PortalActionRequest(service: service, action: action)
        } else {
            Task { await perform(action, on: service) }
        }
    }

    private func perform(_ action: PortalAction, on service: PortalService) async {
        guard working[service.key] == nil else { return }
        working[service.key] = action
        defer { working[service.key] = nil }
        do {
            let updated = try await OS1API.portalAction(
                sessionId: sessionId,
                name: service.name,
                action: action
            )
            guard !Task.isCancelled else { return }
            status = updated
        } catch {
            guard !Task.isCancelled else { return }
            failure = PortalFailure(
                title: action.failureTitle,
                message: error.localizedDescription
            )
            return
        }
        // A restart answers as soon as the supervisor has the service in
        // hand, which is usually before it is listening. One follow-up read
        // turns "Starting" into "Live" without anyone pulling to refresh.
        guard action == .restart else { return }
        try? await Task.sleep(for: .seconds(3))
        guard !Task.isCancelled else { return }
        if let refreshed = try? await OS1API.portals(sessionId: sessionId),
           !Task.isCancelled {
            status = refreshed
        }
    }

    /// Hand the request to the outbox rather than the socket, like every
    /// other message this app sends: it is on disk before the button changes,
    /// and it arrives when the signal does. Queued rather than steering, so
    /// asking for a dev server never cuts into a run mid-thought.
    private func ask(_ recipe: PortalRecipe) {
        guard Outbox.shared.enqueue(
            sessionId: sessionId,
            content: recipe.startPrompt,
            busyMode: "queue",
            user: ServerConfig.shared.userName
        ) != nil else {
            failure = PortalFailure(
                title: "Couldn't ask the agent",
                message: "Too many unsent messages. Send or delete some first."
            )
            return
        }
        asked.insert(recipe.id)
    }

    // MARK: - Loading

    private func load() async {
        loading = true
        loadFailed = false
        let loaded = try? await OS1API.portals(sessionId: sessionId)
        guard !Task.isCancelled else { return }
        if let loaded { status = loaded } else { loadFailed = true }
        loading = false
    }
}

/// One pending stop or restart, with the words that go in front of it.
private struct PortalActionRequest: Identifiable, Equatable {
    let service: PortalService
    let action: PortalAction

    var id: String { "\(service.key)-\(action.rawValue)" }

    var title: String {
        switch action {
        case .stop: "Stop \(service.name)?"
        case .restart: "Wake the sandbox?"
        }
    }

    var message: String {
        switch action {
        case .stop: "It stops serving until something starts it again."
        case .restart: "Restarting \(service.name) wakes this session's sandbox."
        }
    }

    var confirmLabel: String {
        switch action {
        case .stop: "Stop portal"
        case .restart: "Restart portal"
        }
    }
}

/// An action the server refused, shown in its own words.
private struct PortalFailure: Identifiable, Equatable {
    let title: String
    let message: String
    var id: String { title + message }
}

/// One service: where it is, what it is, and whether tapping it does anything.
private struct PortalRow: View {
    let service: PortalService
    /// Whether this row opens the portal. A row that doesn't gets no chevron,
    /// because a chevron is a promise that something happens.
    let opens: Bool
    /// The action in flight, which replaces both the dot and the state word:
    /// the row's own state is the honest one only once the server answers.
    let working: PortalAction?

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 11) {
            Group {
                if working != nil {
                    ProgressView().controlSize(.small)
                } else {
                    Circle()
                        .fill(dotColor)
                        .frame(width: 8, height: 8)
                }
            }
            .frame(width: 22)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(service.name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.text)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    // The state leads so that nothing can truncate it, which
                    // holds while the line is "Live · Port 3000". At an
                    // accessibility size even that is more than one line, and
                    // the state would be all the row could say. Two lines let
                    // the description back in.
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
            }
            Spacer(minLength: 8)
            if opens {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.textFaint)
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(service.name), \(working?.progressLabel ?? service.display.label)")
    }

    /// State first, then what the service is. The web panel has the width to
    /// put its description first; a phone row does not, and a repository's
    /// one-line description will happily eat the whole line. The state is
    /// what this row exists to say, so it goes where nothing can truncate it.
    private var subtitle: String {
        let what = service.description ?? "Port \(service.port)"
        return "\(working?.progressLabel ?? service.display.label) · \(what)"
    }

    private var dotColor: Color {
        switch service.display {
        case .live: OS1VisualStyle.green
        case .starting, .waking: Color.orange
        case .failed: OS1VisualStyle.red
        case .sleeping, .stopped, .unavailable: OS1VisualStyle.textFaint
        }
    }
}

/// A starter the repository declares. The app asks the agent for it; it never
/// runs anything itself.
private struct RecipeRow: View {
    let recipe: PortalRecipe
    let asked: Bool
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(recipe.name)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(OS1VisualStyle.text)
            Text(recipe.subtitle)
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textDim)
                .fixedSize(horizontal: false, vertical: true)
            Button(asked ? "Asked agent" : "Ask agent to start", action: action)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(asked ? OS1VisualStyle.textDim : OS1VisualStyle.link)
                .buttonStyle(.plain)
                .disabled(asked)
                .frame(minHeight: 44)
        }
        .padding(.vertical, 3)
    }
}
#endif
