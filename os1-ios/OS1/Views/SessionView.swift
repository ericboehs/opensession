import SwiftUI
#if os(macOS)
import AppKit
#endif

struct SessionView: View {
    @State private var viewModel: SessionViewModel
    private let tabs: [Session]
    private let onSelectTab: ((Session) -> Void)?
    private let onSaveComposerDraft: ((SessionViewModel.ComposerDraft) -> Void)?
    /// Opens the new-session composer from the iOS navigation bar.
    private let onNewSession: (() -> Void)?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// Full-window-width chat text is unreadable on the Mac; cap the content
    /// column (transcript AND composer) and center it, like other chat apps.
    private let contentMaxWidth = OS1VisualStyle.chatMaxWidth

    /// Mobile web uses a tighter 12pt content rail; regular-width iPad and Mac
    /// keep more breathing room while sharing the same 780pt reading column.
    private var contentInset: CGFloat {
        horizontalSizeClass == .compact ? 12 : 20
    }

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

    /// PR details sheet, opened from the macOS toolbar PR chip.
    #if os(macOS)
    @State private var showPrPanel = false
    #endif

    /// Native counterpart of mobile web's title-opened workspace info page.
    @State private var showWorktreeInfo = false

    init(
        session: Session,
        seed: SessionViewModel.OptimisticSeed? = nil,
        tabs: [Session]? = nil,
        composerDraft: SessionViewModel.ComposerDraft? = nil,
        onSelectTab: ((Session) -> Void)? = nil,
        onSaveComposerDraft: ((SessionViewModel.ComposerDraft) -> Void)? = nil,
        onNewSession: (() -> Void)? = nil
    ) {
        _viewModel = State(initialValue: SessionViewModel(
            session: session,
            seed: seed,
            composerDraft: composerDraft
        ))
        self.tabs = tabs ?? [session]
        self.onSelectTab = onSelectTab
        self.onSaveComposerDraft = onSaveComposerDraft
        self.onNewSession = onNewSession
    }

    init(
        viewModel: SessionViewModel,
        tabs: [Session],
        onSaveComposerDraft: ((SessionViewModel.ComposerDraft) -> Void)? = nil,
        onNewSession: (() -> Void)? = nil
    ) {
        _viewModel = State(initialValue: viewModel)
        self.tabs = tabs
        self.onSelectTab = nil
        self.onSaveComposerDraft = onSaveComposerDraft
        self.onNewSession = onNewSession
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
                                    sessionId: viewModel.session.id
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
                        .padding(.horizontal, contentInset)
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
            VStack(spacing: 0) {
                #if os(iOS)
                if tabs.count > 1, let onSelectTab {
                    SessionTabBar(
                        tabs: tabs,
                        activeId: viewModel.session.id,
                        onSelect: onSelectTab
                    )
                }
                #endif
                statusBanner
            }
        }
        .background(OS1VisualStyle.background.ignoresSafeArea())
        // Bottom inset, not an overlay: the scroll viewport still extends
        // beneath the composer (content scrolls under the floating glass),
        // while the content inset tracks the composer's real height and the
        // keyboard — a fixed overlay padding hid the newest messages behind
        // both.
        .safeAreaInset(edge: .bottom) {
            // A separate view struct on purpose: typing mutates
            // `viewModel.draft` on every keystroke, and any read of it (or
            // `canSend`) inside SessionView.body would re-evaluate this whole
            // body — transcript included — per key. Keep per-keystroke reads
            // out of SessionView.body.
            SessionInputBar(
                viewModel: viewModel,
                contentMaxWidth: contentMaxWidth,
                horizontalInset: contentInset
            )
        }
        #if os(macOS)
        .navigationTitle("")
        .macWindowTitle(viewModel.session.displayTitle)
        #else
        .navigationTitle(viewModel.session.displayTitle)
        #endif
        .inlineTitleBarCompat()
        #if os(iOS)
        .toolbarBackground(.hidden, for: .navigationBar)
        #endif
        .toolbar {
            #if os(iOS)
            ToolbarItem(placement: .principal) {
                sessionIdentityButton
            }
            #endif
            #if os(iOS)
            ToolbarItem(placement: .topTrailingCompat) {
                Button(action: { onNewSession?() }) {
                    Image(systemName: "plus")
                        .foregroundStyle(OS1VisualStyle.text)
                }
                .accessibilityLabel("New chat")
            }
            #else
            // macOS retains the PR chip in its roomier toolbar; on iOS the
            // same panel lives in the title-opened workspace sheet.
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
            #endif
            #if os(macOS)
            ToolbarItem(placement: .principal) { macSessionTitle }
            ToolbarItem(placement: .topTrailingCompat) {
                modelMenu
                    .help("Model and reasoning settings")
            }
            #endif
        }
        #if os(macOS)
        .sheet(isPresented: $showPrPanel) {
            PrPanelView(viewModel: viewModel)
        }
        #endif
        #if os(iOS)
        .sheet(isPresented: $showWorktreeInfo) {
            WorktreeInfoView(
                viewModel: viewModel,
                chats: tabs,
                catalog: catalog
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        #endif
        .task {
            let owner = UUID()
            viewModel.start(owner: owner)
            defer { viewModel.stop(owner: owner) }
            catalog = try? await OS1API.models()
            #if DEBUG && os(iOS)
            if ProcessInfo.processInfo.environment["OS1_OPEN_WORKTREE_INFO"] == "1" {
                showWorktreeInfo = true
            }
            #endif
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3_600))
            }
        }
        .onDisappear {
            onSaveComposerDraft?(SessionViewModel.ComposerDraft(
                text: viewModel.draft,
                images: viewModel.attachedImages
            ))
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
            modelMenuContents
        } label: {
            Image(systemName: "slider.horizontal.3")
        }
    }

    #if os(macOS)
    /// Own the detail title instead of accepting NavigationSplitView's
    /// automatic circular title-menu control, which had no useful action.
    private var macSessionTitle: some View {
        HStack(spacing: 8) {
            RepoTile(name: viewModel.session.effectiveRepo, size: 20)
            Text(viewModel.session.displayTitle)
                .font(.headline)
                .lineLimit(1)
            if viewModel.isRunning {
                PulsingDot(color: OS1VisualStyle.yellow, size: 6)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(maxWidth: 520, alignment: .leading)
        .help(headerSubtitle)
        .accessibilityElement(children: .combine)
    }
    #endif

    #if os(iOS)
    /// Mobile web opens workspace details when its title is tapped. Keep the
    /// same identity in native navigation and present a SwiftUI details sheet.
    private var sessionIdentityButton: some View {
        Button {
            showWorktreeInfo = true
        } label: {
            HStack(spacing: 8) {
                RepoTile(name: viewModel.session.effectiveRepo, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(viewModel.session.displayTitle)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.text)
                            .lineLimit(1)
                        if viewModel.isRunning {
                            PulsingDot(color: .green, size: 6)
                        }
                    }
                    if !dynamicTypeSize.isAccessibilitySize {
                        Text(headerSubtitle)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .lineLimit(1)
                    }
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(OS1VisualStyle.textFaint)
            }
            .frame(maxWidth: 230, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .tint(.primary)
        .accessibilityLabel("Workspace details")
    }
    #endif

    private var currentModel: String {
        viewModel.model.isEmpty ? (catalog?.defaultModel ?? "") : viewModel.model
    }

    private var headerSubtitle: String {
        let label = catalog?.label(for: currentModel) ?? currentModel
        return [RepoTile.label(for: viewModel.session.effectiveRepo), label]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    @ViewBuilder
    private var modelMenuContents: some View {
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

#if os(iOS)
/// Keeps the tab strip anchored while sibling conversations move horizontally
/// according to their order. Recently visited conversations reuse their loaded
/// view model; SessionView still disconnects each socket while it is off-screen.
struct SessionTabsView: View {
    let initialSession: Session
    let tabs: [Session]
    let viewModelForSession: (Session) -> SessionViewModel
    let onSaveComposerDraft: (Session, SessionViewModel.ComposerDraft) -> Void
    let onNewSession: () -> Void

    @State private var activeId: String
    @State private var transitionEdge = Edge.trailing
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        session: Session,
        tabs: [Session],
        viewModelForSession: @escaping (Session) -> SessionViewModel,
        onSaveComposerDraft: @escaping (Session, SessionViewModel.ComposerDraft) -> Void,
        onNewSession: @escaping () -> Void
    ) {
        initialSession = session
        self.tabs = tabs
        self.viewModelForSession = viewModelForSession
        self.onSaveComposerDraft = onSaveComposerDraft
        self.onNewSession = onNewSession
        _activeId = State(initialValue: session.id)
    }

    private var activeSession: Session {
        tabs.first(where: { $0.id == activeId }) ?? tabs.first ?? initialSession
    }

    private var conversationTransition: AnyTransition {
        guard !reduceMotion else { return .opacity }
        let removalEdge: Edge = transitionEdge == .trailing ? .leading : .trailing
        return .asymmetric(
            insertion: .move(edge: transitionEdge).combined(with: .opacity),
            removal: .move(edge: removalEdge).combined(with: .opacity)
        )
    }

    var body: some View {
        ZStack {
            ForEach([activeSession]) { session in
                SessionView(
                    viewModel: viewModelForSession(session),
                    tabs: tabs,
                    onSaveComposerDraft: { draft in
                        onSaveComposerDraft(session, draft)
                    },
                    onNewSession: onNewSession
                )
                .transition(conversationTransition)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // No .clipped() here: this container sits within the safe area, so a
        // clip cuts the transcript's edge-to-edge rendering at the safe-area
        // bounds — an opaque-looking nav bar and a dead strip above the home
        // indicator. Tab-switch slides may draw offscreen; that's invisible
        // on a full-screen push.
        .safeAreaInset(edge: .top, spacing: 0) {
            if tabs.count > 1 {
                SessionTabBar(
                    tabs: tabs,
                    activeId: activeId,
                    onSelect: select
                )
            }
        }
        .onChange(of: tabs) { _, updatedTabs in
            guard !updatedTabs.contains(where: { $0.id == activeId }),
                  let fallback = updatedTabs.first
            else { return }

            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                activeId = fallback.id
            }
        }
    }

    private func select(_ session: Session) {
        guard session.id != activeId,
              let targetIndex = tabs.firstIndex(where: { $0.id == session.id })
        else { return }

        let currentIndex = tabs.firstIndex(where: { $0.id == activeId }) ?? 0
        withAnimation(
            reduceMotion
                ? .easeOut(duration: 0.16)
                : .snappy(duration: 0.26, extraBounce: 0)
        ) {
            transitionEdge = targetIndex > currentIndex ? .trailing : .leading
            activeId = session.id
        }
    }
}

/// Compact workspace chat tabs below the navigation bar. The active tab is
/// centered when the strip opens, while horizontal overflow remains native
/// touch scrolling.
private struct SessionTabBar: View {
    let tabs: [Session]
    let activeId: String
    let onSelect: (Session) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Namespace private var activeTabIndicator

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 4) {
                    ForEach(tabs) { session in
                        let isActive = session.id == activeId
                        Button {
                            if !isActive { onSelect(session) }
                        } label: {
                            HStack(spacing: 7) {
                                if session.waitingForInput == true {
                                    PulsingDot(
                                        color: OS1VisualStyle.blue,
                                        size: 6
                                    )
                                } else if session.isRunning == true {
                                    PulsingDot(
                                        color: OS1VisualStyle.yellow,
                                        size: 6
                                    )
                                }
                                Text(session.displayTitle)
                                    .font(.footnote.weight(
                                        isActive ? .semibold : .medium
                                    ))
                                    .lineLimit(1)
                            }
                            .foregroundStyle(
                                isActive
                                    ? OS1VisualStyle.text
                                    : OS1VisualStyle.textDim
                            )
                            .padding(.horizontal, 12)
                            .frame(minWidth: 44, minHeight: 44)
                            .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? 260 : 180)
                            .background {
                                if isActive {
                                    let indicator = RoundedRectangle(
                                        cornerRadius: 9,
                                        style: .continuous
                                    )
                                    .fill(OS1VisualStyle.hover)

                                    if reduceMotion {
                                        indicator
                                    } else {
                                        indicator.matchedGeometryEffect(
                                            id: "active-session-tab",
                                            in: activeTabIndicator
                                        )
                                    }
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .id(session.id)
                        .accessibilityAddTraits(
                            isActive ? .isSelected : []
                        )
                        .accessibilityValue(tabAccessibilityValue(session))
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }
            .scrollIndicators(.hidden)
            // Translucent material, not an opaque .bar and not nothing: the
            // transcript ghosts through, but the tab labels stay legible
            // over busy content.
            .background(.ultraThinMaterial)
            .onAppear {
                proxy.scrollTo(activeId, anchor: .center)
            }
            .onChange(of: activeId) { _, id in
                if reduceMotion {
                    proxy.scrollTo(id, anchor: .center)
                } else {
                    withAnimation(.snappy) { proxy.scrollTo(id, anchor: .center) }
                }
            }
        }
    }

    private func tabAccessibilityValue(_ session: Session) -> String {
        let state = if session.waitingForInput == true {
            "Needs input"
        } else if session.isRunning == true {
            "Running"
        } else {
            "Idle"
        }
        return session.id == activeId ? "Selected, \(state)" : state
    }
}
#endif

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
    @AppStorage("os1.composer.sendKey") private var sendKey = "enter"
    @AppStorage("os1.composer.busySend") private var busySend = "queue"
    /// Matches the transcript column cap so the bar centers with it.
    let contentMaxWidth: CGFloat
    let horizontalInset: CGFloat
    @FocusState private var inputFocused: Bool

    #if os(macOS)
    /// Local key monitor that turns Shift+Return into a newline insert.
    @State private var shiftReturnMonitor: Any?
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if viewModel.isRunning
                || (viewModel.queuedCount > 0 && viewModel.queuedItems.isEmpty)
                || visibleNotice != nil {
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
                    if let notice = visibleNotice {
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

            VStack(spacing: 0) {
                if hasQueueItems {
                    queueFlap
                        .zIndex(0)
                }
                composer
                    .zIndex(1)
            }
        }
        .frame(maxWidth: contentMaxWidth)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, horizontalInset)
        .padding(.top, 6)
        #if os(iOS)
        .padding(.bottom, 8)
        #else
        .padding(.bottom, 8)
        #endif
        // No bar background: the composer and chips are individual glass
        // elements floating over the transcript, which scrolls beneath them
        // through the soft scroll edge and progressive material fade.
        #if os(macOS)
        .onAppear { installShiftReturnMonitor() }
        .onDisappear { removeShiftReturnMonitor() }
        #endif
    }

    private var hasQueueItems: Bool {
        !viewModel.deliveringItems.isEmpty || !viewModel.steeredItems.isEmpty
            || !viewModel.queuedItems.isEmpty
    }

    private var visibleNotice: String? {
        guard let notice = viewModel.notice else { return nil }
        if case .connected = viewModel.connectionState { return notice }
        let normalized = notice.lowercased()
        return normalized.contains("connect") || normalized.contains("socket")
            ? nil
            : notice
    }

    /// The queue uses the web composer's flap treatment: inset from the input,
    /// rounded at the top, and tucked behind the composer at the bottom.
    private var queueFlap: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(queueTitle)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textFaint)

            ForEach(viewModel.deliveringItems) { item in
                QueuedMessageRow(item: item, phase: .delivering)
            }
            ForEach(viewModel.steeredItems) { item in
                QueuedMessageRow(item: item, phase: .steering)
            }
            ForEach(viewModel.queuedItems) { item in
                QueuedMessageRow(
                    item: item,
                    phase: .queued,
                    onSteer: viewModel.isRunning
                        ? { viewModel.steerQueued(item) } : nil,
                    onDelete: { viewModel.deleteQueued(item) }
                )
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 24)
        .background(
            OS1VisualStyle.panel.opacity(0.9),
            in: UnevenRoundedRectangle(
                topLeadingRadius: 16,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: 16,
                style: .continuous
            )
        )
        .overlay {
            UnevenRoundedRectangle(
                topLeadingRadius: 16,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: 16,
                style: .continuous
            )
            .stroke(OS1VisualStyle.border, lineWidth: 0.5)
        }
        .padding(.horizontal, 18)
        .padding(.bottom, -14)
    }

    private var queueTitle: String {
        let queued = viewModel.queuedItems.count
        let inFlight = viewModel.steeredItems.count + viewModel.deliveringItems.count
        if queued == 0 {
            return "\(inFlight) in flight"
        }
        if inFlight == 0 {
            return "\(queued) queued \(queued == 1 ? "message" : "messages")"
        }
        return "\(queued) queued · \(inFlight) in flight"
    }

    /// The message composer mirrors the web input: draft above, controls on a
    /// bottom row, including stop while a turn is active.
    private var composer: some View {
        VStack(alignment: .leading, spacing: 2) {
            TextField(
                viewModel.isRunning
                    ? (busySend == "steer" ? "Message — steers this run" : "Message — queues for after this run")
                    : "Message",
                text: $viewModel.draft,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .lineLimit(1...10)
            .padding(.horizontal, 10)
            .padding(.top, 9)
            .padding(.bottom, 5)
            .focused($inputFocused)
            // Mac: Return sends; Shift/Option-Return insert a newline. On
            // iOS the software keyboard's return key just wraps, as before.
            .onSubmit {
                #if os(iOS)
                viewModel.sendDraft()
                #else
                if sendKey == "enter" { viewModel.sendDraft() }
                #endif
            }
            // A copied screenshot pastes straight into the attachments
            // (Cmd+V on Mac, long-press Paste on iOS); text pastes flow
            // through to the field untouched.
            .pastesImages(into: $viewModel.attachedImages)

            HStack(spacing: 6) {
                AttachImagesButton(images: $viewModel.attachedImages)
                Spacer(minLength: 8)

                if viewModel.isRunning {
                    stopButton
                }

                Button {
                    viewModel.sendDraft()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(viewModel.canSend ? Color.white : Color.secondary)
                        .frame(width: 32, height: 32)
                        .background(
                            viewModel.canSend
                                ? AnyShapeStyle(.tint)
                                : AnyShapeStyle(.fill.secondary),
                            in: Circle()
                        )
                }
                .buttonStyle(.plain)
                .disabled(!viewModel.canSend)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
                .animation(.easeOut(duration: 0.15), value: viewModel.canSend)
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 3)
        }
        #if os(iOS)
        .background(
            .ultraThinMaterial,
            in: RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous)
        )
        #endif
        .glassSurface(
            in: RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous)
        )
        #if os(iOS)
        .overlay {
            RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous)
                .stroke(
                    inputFocused ? Color.accentColor.opacity(0.45) : .clear,
                    lineWidth: 1
                )
                .allowsHitTesting(false)
        }
        .contentShape(
            RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous)
        )
        .simultaneousGesture(
            TapGesture().onEnded { inputFocused = true }
        )
        .animation(.easeOut(duration: 0.15), value: inputFocused)
        #endif
    }

    @ViewBuilder
    private var stopButton: some View {
        #if os(macOS)
        Button {
            viewModel.cancelRun()
        } label: {
            Label("Stop", systemImage: "stop.fill")
                .font(.caption.weight(.medium))
        }
        .buttonStyle(.bordered)
        .tint(OS1VisualStyle.red)
        .controlSize(.small)
        .frame(minWidth: 68, minHeight: 44)
        .help("Stop current turn")
        #else
        Button {
            viewModel.cancelRun()
        } label: {
            Image(systemName: "stop.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(OS1VisualStyle.red, in: Circle())
        }
        .buttonStyle(.plain)
        .frame(width: 44, height: 44)
        .contentShape(Circle())
        .accessibilityLabel("Stop current turn")
        #endif
    }

    private var composerCornerRadius: CGFloat {
        #if os(macOS)
        18
        #else
        26
        #endif
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
                guard inputFocused, event.keyCode == 36 || event.keyCode == 76 else {
                    return event
                }
                let preferredSendKey = UserDefaults.standard.string(
                    forKey: "os1.composer.sendKey"
                ) ?? "enter"
                if mods == .command || mods == .control {
                    let mode = UserDefaults.standard.string(
                        forKey: "os1.composer.busySendMod"
                    ) ?? "steer"
                    viewModel.sendDraft(busyModeOverride: mode)
                    return nil
                }
                if mods == .shift || (mods.isEmpty && preferredSendKey == "mod-enter") {
                    NSApp.sendAction(
                        #selector(NSTextView.insertNewlineIgnoringFieldEditor(_:)),
                        to: nil, from: nil
                    )
                    return nil
                }
                return event
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

    // MARK: - Queue rows

    /// One message waiting on the current run. "Queued" holds until the run
    /// fully finishes; "Steering" is already committed to deliver at the
    /// run's next turn boundary (a receipt — no actions left to take);
    /// "Delivering" has left the server queue and is waiting on its
    /// transcript echo (~1s file watcher) — inert, just kept visible.
    private struct QueuedMessageRow: View {
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
        }
    }
}
