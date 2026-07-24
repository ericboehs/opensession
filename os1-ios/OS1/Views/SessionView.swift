import SwiftUI
#if os(macOS)
import AppKit
#endif

struct SessionView: View {
    @State private var viewModel: SessionViewModel
    @FocusState private var inputFocused: Bool
    @Environment(\.scenePhase) private var scenePhase

    /// Full-window-width chat text is unreadable on the Mac; cap the content
    /// column (transcript AND composer) and center it, like other chat apps.
    private let contentMaxWidth: CGFloat = 720

    /// Anchor for restoring the scroll position after a requested history
    /// prepend: the entry that was topmost stays where the reader left it.
    @State private var prependAnchorId: String?

    /// Model/effort catalog for the toolbar picker; fetched on first open.
    @State private var catalog: ModelCatalog?

    #if os(macOS)
    /// Local key monitor that turns Shift+Return into a newline insert.
    @State private var shiftReturnMonitor: Any?
    #endif

    init(session: Session, seed: SessionViewModel.OptimisticSeed? = nil) {
        _viewModel = State(initialValue: SessionViewModel(session: session, seed: seed))
    }

    var body: some View {
        ScrollViewReader { proxy in
            Group {
                if viewModel.isLoadingConversation {
                    conversationLoader
                } else {
                    ScrollView {
                        LazyVStack(spacing: 10) {
                            if viewModel.canLoadEarlier || viewModel.loadingEarlier {
                                historyLoader
                            }
                            ForEach(viewModel.displayItems) { item in
                                TranscriptRow(
                                    item: item,
                                    showsUserAvatar: viewModel.avatarItemIds.contains(item.id)
                                )
                                .id(item.id)
                            }
                            if !viewModel.liveText.isEmpty {
                                StreamingBubble(text: viewModel.liveText)
                                    .id("live-stream")
                            }
                            if let ask = viewModel.pendingQuestion {
                                AskQuestionCard(ask: ask) { answers in
                                    viewModel.answer(question: ask, answers: answers)
                                }
                                .id("ask-\(ask.id)")
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .frame(maxWidth: contentMaxWidth)
                        .frame(maxWidth: .infinity)
                    }
                    // Initial render lands at the bottom and stays pinned while
                    // lazy rows settle. The pin releases when the person scrolls
                    // up to read, so new output does not yank them back.
                    .softScrollEdges()
                    .defaultScrollAnchor(.bottom)
                    .defaultScrollAnchor(.bottom, for: .sizeChanges)
                    .scrollDismissesKeyboardCompat()
                    .onChange(of: viewModel.pendingQuestion) {
                        // A question needs eyes even if they've scrolled away.
                        scrollToBottom(proxy, animated: true)
                    }
                    .onChange(of: viewModel.historyPrependSeq) {
                        // Keep the reader where they were: the entry that was at
                        // the top of the viewport stays there.
                        if let anchor = prependAnchorId {
                            proxy.scrollTo(anchor, anchor: .top)
                        }
                        prependAnchorId = nil
                    }
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            statusBanner
        }
        .safeAreaInset(edge: .bottom) {
            inputBar
        }
        .navigationTitle(viewModel.session.displayTitle)
        .inlineTitleBarCompat()
        .toolbar {
            ToolbarItem(placement: .topTrailingCompat) {
                modelMenu
            }
            if viewModel.isRunning {
                ToolbarItem(placement: .topTrailingCompat) {
                    Button {
                        viewModel.cancelRun()
                    } label: {
                        Image(systemName: "stop.circle")
                    }
                }
            }
        }
        .task {
            viewModel.start()
            #if os(macOS)
            installShiftReturnMonitor()
            #endif
            catalog = try? await OS1API.models()
        }
        .onDisappear {
            viewModel.stop()
            #if os(macOS)
            removeShiftReturnMonitor()
            #endif
        }
        .onChange(of: scenePhase) { _, phase in
            // Backgrounding leaves the socket half-open more often than not;
            // resync (and reconnect if dead) the moment we're visible again.
            if phase == .active { viewModel.appDidBecomeActive() }
        }
    }

    private var conversationLoader: some View {
        VStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            Text("Loading conversation…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Sits above the oldest rendered entry; scrolling it into view pages in
    /// the previous window of history (with a button as the manual fallback).
    private var historyLoader: some View {
        HStack(spacing: 6) {
            if viewModel.loadingEarlier {
                ProgressView()
                    .controlSize(.small)
                Text("Loading earlier…")
            } else {
                Button("Load earlier history") { requestEarlier() }
                    .buttonStyle(.borderless)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .onAppear { requestEarlier() }
    }

    private func requestEarlier() {
        guard viewModel.canLoadEarlier, !viewModel.loadingEarlier else { return }
        prependAnchorId = viewModel.displayItems.first?.id
        viewModel.loadEarlier()
    }

    @ViewBuilder
    private var statusBanner: some View {
        switch viewModel.connectionState {
        case .connected:
            EmptyView()
        case .connecting:
            bannerText("Connecting…", color: .secondary)
        case .reconnecting(let reason):
            bannerText(reason.map { "\($0) — reconnecting…" } ?? "Reconnecting…", color: .orange)
        }
    }

    /// Floating glass capsule under the nav bar, instead of a full-width bar.
    private func bannerText(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(color)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .glassSurface(in: Capsule())
            .padding(.top, 6)
            .frame(maxWidth: .infinity)
    }

    private var inputBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Messages waiting on the current run, each visibly either
            // queued (held until the run finishes — steerable/deletable)
            // or steering in (delivering at the next turn boundary).
            if !viewModel.steeredItems.isEmpty || !viewModel.queuedItems.isEmpty {
                VStack(spacing: 6) {
                    ForEach(viewModel.steeredItems) { item in
                        QueuedMessageChip(item: item, steering: true)
                    }
                    ForEach(viewModel.queuedItems) { item in
                        QueuedMessageChip(
                            item: item,
                            steering: false,
                            onSteer: viewModel.isRunning
                                ? { viewModel.steerQueued(item) } : nil,
                            onDelete: { viewModel.deleteQueued(item) }
                        )
                    }
                }
            }
            if viewModel.isRunning
                || (viewModel.queuedCount > 0 && viewModel.queuedItems.isEmpty)
                || viewModel.notice != nil {
                // Compact glass chip floating above the composer.
                HStack(spacing: 6) {
                    if viewModel.isRunning {
                        // Pulsing dot + live elapsed clock, like the web
                        // viewer's busy row — not a static "Running" label.
                        PulsingDot(color: .green, size: 7)
                        RunElapsedLabel(since: viewModel.runStartedAt)
                            .foregroundStyle(.secondary)
                    }
                    if viewModel.queuedCount > 0, viewModel.queuedItems.isEmpty {
                        // Pre-handshake count from the sessions list, before
                        // the watch delivers the actual items.
                        Text("\(viewModel.queuedCount) queued")
                            .foregroundStyle(.secondary)
                    }
                    if let notice = viewModel.notice {
                        Text(notice)
                            .foregroundStyle(.orange)
                            .lineLimit(1)
                    }
                }
                .font(.caption2)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .glassSurface(in: Capsule())
            }

            if !viewModel.attachedImages.isEmpty {
                AttachedImagesRow(images: viewModel.attachedImages) { image in
                    viewModel.attachedImages.removeAll { $0.id == image.id }
                }
            }

            composer
        }
        .frame(maxWidth: contentMaxWidth)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 10)
        // No bar background: the composer and chips are individual glass
        // elements floating over the transcript, which scrolls beneath them
        // through the soft scroll-edge fade.
    }

    /// Model / reasoning-effort / fast-mode controls, mirroring the web
    /// composer's pill: effort levels and fast toggle up top, the model list
    /// behind a submenu. Model switches route through `/model` (persisted +
    /// noticed); effort/fast ride the next send.
    private var modelMenu: some View {
        Menu {
            let currentModel = viewModel.model.isEmpty
                ? (catalog?.defaultModel ?? "") : viewModel.model
            if let option = catalog?.option(for: currentModel),
               let efforts = option.efforts, !efforts.isEmpty {
                Section("Reasoning") {
                    ForEach(efforts, id: \.self) { level in
                        Button {
                            viewModel.effort = level
                        } label: {
                            if viewModel.effort == level {
                                Label(EffortLevel.label(level), systemImage: "checkmark")
                            } else {
                                Text(EffortLevel.label(level))
                            }
                        }
                    }
                }
            }
            if catalog?.option(for: currentModel)?.fastModeSupported == true {
                Button {
                    viewModel.fastMode.toggle()
                } label: {
                    if viewModel.fastMode {
                        Label("Fast mode", systemImage: "checkmark")
                    } else {
                        Text("Fast mode")
                    }
                }
            }
            if let catalog {
                Menu {
                    ForEach(catalog.presets + catalog.regular) { option in
                        Button {
                            viewModel.changeModel(to: option.id)
                        } label: {
                            if option.id == currentModel {
                                Label(option.displayLabel, systemImage: "checkmark")
                            } else {
                                Text(option.displayLabel)
                            }
                        }
                    }
                } label: {
                    Label(
                        "Model — \(catalog.label(for: currentModel))",
                        systemImage: "cpu"
                    )
                }
            }
        } label: {
            Image(systemName: "slider.horizontal.3")
        }
    }

    /// The message composer: one bordered rounded container holding the
    /// multiline text field and an embedded send button — the shape chat
    /// apps converge on, instead of a floating button next to a pill.
    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            AttachImagesButton(images: $viewModel.attachedImages)
                .padding(.bottom, 3)
            PasteImagesButton(images: $viewModel.attachedImages)
                .padding(.bottom, 3)
            TextField(
                viewModel.isRunning ? "Message — queues for after this run" : "Message",
                text: $viewModel.draft,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .lineLimit(1...10)
            .padding(.leading, 6)
            .padding(.vertical, 7)
            .focused($inputFocused)
            // Mac: Return sends; Shift/Option-Return insert a newline. On
            // iOS the software keyboard's return key just wraps, as before.
            .onSubmit { viewModel.sendDraft() }
            // A copied screenshot pastes straight into the attachments
            // (Cmd+V); text pastes flow through to the field untouched.
            .pastesImages(into: $viewModel.attachedImages)

            Button {
                viewModel.sendDraft()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(viewModel.canSend ? Color.white : Color.secondary)
                    .frame(width: 27, height: 27)
                    .background(
                        viewModel.canSend
                            ? AnyShapeStyle(.tint)
                            : AnyShapeStyle(.fill.secondary),
                        in: Circle()
                    )
            }
            .buttonStyle(.plain)
            .disabled(!viewModel.canSend)
            .padding(.bottom, 3)
            .padding(.trailing, 1)
            .animation(.easeOut(duration: 0.15), value: viewModel.canSend)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .glassSurface(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    #if os(macOS)
    /// Shift+Return inserts a newline while plain Return sends: a local key
    /// monitor routes it to the focused field editor as
    /// `insertNewlineIgnoringFieldEditor` (the same path Option+Return takes
    /// natively), so the break lands at the cursor.
    private func installShiftReturnMonitor() {
        guard shiftReturnMonitor == nil else { return }
        shiftReturnMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            MainActor.assumeIsolated {
                let mods = event.modifierFlags
                    .intersection(.deviceIndependentFlagsMask)
                    .subtracting(.capsLock)
                guard inputFocused,
                      event.keyCode == 36 || event.keyCode == 76,
                      mods == .shift
                else { return event }
                NSApp.sendAction(
                    #selector(NSTextView.insertNewlineIgnoringFieldEditor(_:)),
                    to: nil, from: nil
                )
                return nil
            }
        }
    }

    private func removeShiftReturnMonitor() {
        if let monitor = shiftReturnMonitor {
            NSEvent.removeMonitor(monitor)
            shiftReturnMonitor = nil
        }
    }
    #endif

    // MARK: - Queue chips

    /// One message waiting on the current run. "Queued" holds until the run
    /// fully finishes; "Steering" is already committed to deliver at the
    /// run's next turn boundary (a receipt — no actions left to take).
    private struct QueuedMessageChip: View {
        let item: QueueItem
        let steering: Bool
        var onSteer: (() -> Void)?
        var onDelete: (() -> Void)?

        var body: some View {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(steering ? "Steering — delivers next turn" : "Queued — after this run")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(steering ? Color.green : Color.orange)
                    Text(item.content)
                        .font(.footnote)
                        .lineLimit(2)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if let onSteer {
                    Button("Steer", action: onSteer)
                        .font(.footnote.weight(.medium))
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                }
                if let onDelete {
                    Button(action: onDelete) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .glassSurface(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        let target: String
        if viewModel.pendingQuestion != nil {
            target = "ask-\(viewModel.pendingQuestion!.id)"
        } else if !viewModel.liveText.isEmpty {
            target = "live-stream"
        } else if let last = viewModel.displayItems.last {
            target = last.id
        } else {
            return
        }
        if animated {
            withAnimation(.snappy) { proxy.scrollTo(target, anchor: .bottom) }
        } else {
            proxy.scrollTo(target, anchor: .bottom)
        }
    }
}
