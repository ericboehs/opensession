import SwiftUI
#if os(macOS)
import AppKit
#endif

struct SessionView: View {
    @State private var viewModel: SessionViewModel
    @Environment(\.scenePhase) private var scenePhase

    /// Full-window-width chat text is unreadable on the Mac; cap the content
    /// column (transcript AND composer) and center it, like other chat apps.
    private let contentMaxWidth: CGFloat = 720

    /// Anchor for restoring the scroll position after a requested history
    /// prepend: the entry that was topmost stays where the reader left it.
    @State private var prependAnchorId: String?

    /// Whether the reader is at (or near) the bottom, from live scroll
    /// geometry. New AI output only auto-scrolls while true; scrolling up to
    /// read releases the pin so streams don't yank the reader back down.
    @State private var pinnedToBottom = true

    /// How close to the bottom (pt) still counts as pinned — forgiving enough
    /// to survive keyboard/inset transitions and lazy row settling.
    private let pinTolerance: CGFloat = 80

    /// Model/effort catalog for the toolbar picker; fetched on first open.
    @State private var catalog: ModelCatalog?

    /// PR details sheet, opened from the toolbar PR chip.
    @State private var showPrPanel = false

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
                                    sessionId: viewModel.session.id,
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
                    // Pin state from real scroll geometry: pinned while the
                    // visible bottom edge is within pinTolerance of the
                    // content's end. Precise on release (unlike a lazy-stack
                    // sentinel, whose realization window lags actual
                    // visibility) and it costs a state write only when the
                    // Bool flips, not per scroll tick.
                    .onScrollGeometryChange(for: Bool.self) { geometry in
                        geometry.contentOffset.y + geometry.containerSize.height
                            >= geometry.contentSize.height
                                + geometry.contentInsets.bottom - pinTolerance
                    } action: { _, isNearBottom in
                        pinnedToBottom = isNearBottom
                    }
                    .onChange(of: viewModel.pendingQuestion) {
                        // A question needs eyes even if they've scrolled away.
                        scrollToBottom(proxy, animated: true)
                    }
                    .onChange(of: viewModel.sendSeq) {
                        // Your own send always lands in view. The bottom
                        // size-change anchor alone doesn't re-pin once the
                        // reader has scrolled up (or the keyboard resized the
                        // viewport), leaving the just-sent bubble below the fold.
                        scrollToBottom(proxy, animated: true)
                    }
                    // The size-change anchor alone doesn't reliably hold the
                    // bottom while new output arrives (keyboard insets + lazy
                    // row settling knock it loose), so follow explicitly while
                    // pinned: new items animated, per-chunk stream growth not
                    // (an animation every ~120ms flush reads as rubber-banding).
                    .onChange(of: viewModel.displayItems.count) {
                        if pinnedToBottom { scrollToBottom(proxy, animated: true) }
                    }
                    .onChange(of: viewModel.liveText) {
                        if pinnedToBottom { scrollToBottom(proxy, animated: false) }
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
            // A separate view struct on purpose: typing mutates
            // `viewModel.draft` on every keystroke, and any read of it (or
            // `canSend`) inside SessionView.body would re-evaluate this whole
            // body — transcript included — per key. Keep per-keystroke reads
            // out of SessionView.body.
            SessionInputBar(viewModel: viewModel, contentMaxWidth: contentMaxWidth)
        }
        .navigationTitle(viewModel.session.displayTitle)
        .inlineTitleBarCompat()
        .toolbar {
            // PR chip: number + status dot. Present as soon as either the
            // fetched details or the sessions-list snapshot know of a PR.
            if let prNumber = viewModel.prDetails?.number ?? viewModel.session.prNumber {
                ToolbarItem(placement: .topTrailingCompat) {
                    Button {
                        showPrPanel = true
                    } label: {
                        PrChipLabel(number: prNumber, summary: viewModel.prDetails?.summary)
                    }
                    .accessibilityLabel(Text(verbatim: "Pull request #\(prNumber)"))
                }
            }
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
        .sheet(isPresented: $showPrPanel) {
            PrPanelView(viewModel: viewModel)
        }
        .task {
            viewModel.start()
            catalog = try? await OS1API.models()
        }
        .onDisappear {
            viewModel.stop()
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

/// The bottom input area: queue/steer/delivering chips, the run-status chip,
/// staged images, and the composer. A SEPARATE view struct on purpose — its
/// body is the only place that reads `viewModel.draft` / `canSend`, so with
/// @Observable's per-body tracking a keystroke invalidates just this bar.
/// When these lived as computed properties of SessionView, every keystroke
/// re-evaluated SessionView.body and re-diffed every visible transcript row
/// on the main thread — typing visibly hitched on long sessions even with
/// nothing streaming.
private struct SessionInputBar: View {
    @Bindable var viewModel: SessionViewModel
    /// Matches the transcript column cap so the bar centers with it.
    let contentMaxWidth: CGFloat
    @FocusState private var inputFocused: Bool

    #if os(macOS)
    /// Local key monitor that turns Shift+Return into a newline insert.
    @State private var shiftReturnMonitor: Any?
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Messages waiting on the current run, each visibly either
            // delivering (left the server queue, transcript echo in flight),
            // queued (held until the run finishes — steerable/deletable)
            // or steering in (delivering at the next turn boundary).
            if !viewModel.deliveringItems.isEmpty || !viewModel.steeredItems.isEmpty
                || !viewModel.queuedItems.isEmpty {
                VStack(spacing: 6) {
                    ForEach(viewModel.deliveringItems) { item in
                        QueuedMessageChip(item: item, phase: .delivering)
                    }
                    ForEach(viewModel.steeredItems) { item in
                        QueuedMessageChip(item: item, phase: .steering)
                    }
                    ForEach(viewModel.queuedItems) { item in
                        QueuedMessageChip(
                            item: item,
                            phase: .queued,
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
        #if os(macOS)
        .onAppear { installShiftReturnMonitor() }
        .onDisappear { removeShiftReturnMonitor() }
        #endif
    }

    /// The message composer: one bordered rounded container holding the
    /// multiline text field and an embedded send button — the shape chat
    /// apps converge on, instead of a floating button next to a pill.
    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            // 4.5 centers the 27pt buttons on the field's single-line text
            // (36pt tall: 22pt line + 7pt vertical padding); when the field
            // grows they stay pinned to the last line via .bottom alignment.
            AttachImagesButton(images: $viewModel.attachedImages)
                .padding(.bottom, 4.5)
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
            // (Cmd+V on Mac, long-press Paste on iOS); text pastes flow
            // through to the field untouched.
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
            .padding(.bottom, 4.5)
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
    /// run's next turn boundary (a receipt — no actions left to take);
    /// "Delivering" has left the server queue and is waiting on its
    /// transcript echo (~1s file watcher) — inert, just kept visible.
    private struct QueuedMessageChip: View {
        enum Phase { case queued, steering, delivering }

        let item: QueueItem
        let phase: Phase
        var onSteer: (() -> Void)?
        var onDelete: (() -> Void)?

        private var label: String {
            switch phase {
            case .queued: "Queued — after this run"
            case .steering: "Steering — delivers next turn"
            case .delivering: "Delivering…"
            }
        }

        var body: some View {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(phase == .queued ? Color.orange : Color.green)
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
}
