import SwiftUI

/// Compose a new session, laid out like the palette on the desktop: what the
/// session IS — the repo, and what it's created from — reads across the top,
/// the prompt fills the middle, and how it runs sits in the footer with the
/// attach button. Only the controls this app actually carries appear; the rest
/// of the palette's row (connected services) has no native equivalent yet, so
/// it stays absent rather than half-present. Where the session runs is one
/// chip, and only on instances that offer more than the host.
/// Screenshots paste straight into the attachments (Cmd+V on the Mac,
/// long-press Paste on iOS).
///
/// The prompt lives in a plain `TextEditor` inside a custom layout (not a
/// grouped Form): Form re-diffs every row on each keystroke, which is what
/// made typing lag in the old sheet.
struct NewSessionView: View {
    @Environment(\.dismiss) private var dismiss

    /// Preset repo (the per-repo "+" in the sessions list); nil = remembered.
    var initialRepo: String?

    /// Workspace this session joins as a new tab (the session's ⋯ → "New
    /// session in this workspace"); nil starts a standalone session in its own
    /// workspace.
    var initialWorkspaceId: String?

    /// A parked prompt on that workspace. Opening its sessionless row feeds
    /// the same New Session surface rather than inventing a second composer.
    var initialDraft: OS1API.WorkspaceDraft?

    /// Open with the mic already listening — the Action Button's "Start an
    /// Agent" (see `StartAgentIntent`), where the whole point is to speak
    /// before you have found the keyboard.
    var autoDictate = false

    /// Called the moment Start is tapped, with an optimistic session row
    /// (temporary `pending-` id) plus the prompt/images to seed the
    /// conversation view instantly.
    let onCreated: (Session, SessionViewModel.OptimisticSeed) -> Void

    /// Called when the background create finishes: the temp id and either
    /// the server's real session id or the error to surface.
    let onResolved: (String, Result<String, Error>) -> Void

    /// The unsent prompt was parked without creating a session.
    let onDraftSaved: (OS1API.WorkspaceSummary) -> Void

    init(
        initialRepo: String? = nil,
        initialWorkspaceId: String? = nil,
        initialDraft: OS1API.WorkspaceDraft? = nil,
        autoDictate: Bool = false,
        onCreated: @escaping (Session, SessionViewModel.OptimisticSeed) -> Void,
        onResolved: @escaping (String, Result<String, Error>) -> Void,
        onDraftSaved: @escaping (OS1API.WorkspaceSummary) -> Void = { _ in }
    ) {
        self.initialRepo = initialRepo
        self.initialWorkspaceId = initialWorkspaceId
        self.initialDraft = initialDraft
        self.autoDictate = autoDictate
        self.onCreated = onCreated
        self.onResolved = onResolved
        self.onDraftSaved = onDraftSaved
    }

    @State private var prompt = ""
    @State private var mode = "code"
    @State private var repos: [OS1API.RepoInfo] = []
    @State private var repo = ""
    @State private var catalog: ModelCatalog?
    @State private var model = ""
    @State private var effort = ""
    @State private var fastMode = false
    @State private var images: [AttachedImage] = []
    /// "" is the host. Never seeded from the instance's own default: the chip
    /// is what tells you where this session will run, so it starts on the one
    /// answer that is true everywhere.
    @State private var sandbox = SandboxOffering.host
    @State private var sandboxStatus: InstanceSandboxStatus?
    @State private var showLibrary = false
    @State private var savingDraft = false
    @State private var draftSaveError: String?
    /// Owned here, like the session composer's: the button reads it, this view
    /// keeps it alive across the layout changes a long dictation causes.
    @State private var dictation = Dictation()
    @State private var sessionProjection = ComposerSessionProjectionState()
    @FocusState private var promptFocused: Bool

    /// The universal "+" reopens on whatever repo was used last.
    @AppStorage("os1.newSession.repo") private var lastRepo = ""
    @AppStorage("os1.composer.defaultModel") private var preferredModel = ""
    @AppStorage("os1.composer.defaultEngine") private var preferredEngine = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                editor
                if !images.isEmpty {
                    AttachedImagesRow(images: images) { image in
                        images.removeAll { $0.id == image.id }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)
                }
                Divider()
                controls
            }
            .background(OS1VisualStyle.background)
            .navigationTitle("New session")
            .inlineTitleBarCompat()
            .toolbar {
                #if os(iOS)
                // Both ends draw their own circle, so both hide the toolbar's
                // glass: a capsule around the send disc read as a white ring on
                // the black accent, and the ✕'s glass — white on a white sheet —
                // was nearly invisible next to it. Hiding it on one side only
                // also cost 4pt of symmetry: iOS insets a glass item and a bare
                // one differently.
                ToolbarItem(placement: .confirmationAction) { startButton }
                    .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .cancellationAction) { cancelButton }
                    .sharedBackgroundVisibility(.hidden)
                #else
                ToolbarItem(placement: .confirmationAction) { startButton }
                ToolbarItem(placement: .cancellationAction) { cancelButton }
                #endif
            }
            .task { await load() }
            // The library is a detail of composing this session, so it pushes
            // onto the sheet's own stack: back is where you were, with the
            // prompt filled in.
            .navigationDestination(isPresented: $showLibrary) {
                LibraryView(onPick: apply)
            }
            // Coming back from the library, the editor would otherwise take
            // focus again and put the keyboard over the prompt you just chose.
            // Landing on the whole text is the point; a tap starts editing.
            .onChange(of: showLibrary) { _, shown in
                if !shown { promptFocused = false }
            }
            // Swiping the sheet away is as much a "never mind" as Cancel; the
            // mic must not outlive either.
            .onDisappear { dictation.stop() }
            .alert(
                "Couldn't save draft",
                isPresented: Binding(
                    get: { draftSaveError != nil },
                    set: { if !$0 { draftSaveError = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(draftSaveError ?? "")
            }
        }
        // The floor belongs to the stack, not to its first screen. A macOS
        // sheet sizes to its content, so applied inside, a push replaced it
        // with a view that asks for nothing and the sheet collapsed to its
        // title bar. That is how the whole library came up empty behind
        // "Start from a recipe".
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 440)
        #endif
    }

    // ── Prompt editor ─────────────────────────────────────────────────────

    private var startDisabled: Bool {
        savingDraft
            || (prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty)
    }

    /// Starting a session is the same gesture as sending a message, so on iOS
    /// it wears the composer's send disc rather than the word "Start", with the
    /// ✕ that dismisses the sheet as its pair. The Mac keeps text buttons — a
    /// bare glyph in a sheet toolbar reads as unfinished there.
    @ViewBuilder
    private var startButton: some View {
        #if os(iOS)
        Button { create() } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(
                    startDisabled ? OS1VisualStyle.textDim : OS1VisualStyle.onAccent
                )
                // 44pt, not the composer's 32: this disc replaces a toolbar
                // item's own glass circle, and iOS draws that at 44 — the ✕
                // across the bar measures exactly that. At 32 the pair read as
                // two different kinds of control, and the primary action was
                // the one below the tap-target floor.
                .frame(width: 44, height: 44)
                .background(
                    startDisabled
                        ? AnyShapeStyle(OS1VisualStyle.hover)
                        : AnyShapeStyle(OS1VisualStyle.accent),
                    in: Circle()
                )
        }
        .buttonStyle(.plain)
        .disabled(startDisabled)
        // A bare toolbar item sits 20pt off the edge; the sheet's own column —
        // the chips below, and the prompt under them — is 16. Pull both circles
        // onto it so the header has one left and one right edge.
        .padding(.trailing, -4)
        .keyboardShortcut(.return, modifiers: .command)
        .accessibilityLabel("Start session")
        #else
        Button("Start") { create() }
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(startDisabled)
        #endif
    }

    @ViewBuilder
    private var cancelButton: some View {
        #if os(iOS)
        // The send disc's twin: same 44pt circle, same glyph size, and the
        // neutral fill the sheet's own chips wear. Only the role colour differs,
        // so the bar reads as a pair — a bare glyph opposite a solid accent disc
        // left the sheet lopsided.
        Button { dismiss() } label: {
            Image(systemName: "xmark")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(OS1VisualStyle.text)
                .frame(width: 44, height: 44)
                .background(OS1VisualStyle.hover, in: Circle())
        }
        .buttonStyle(.plain)
        .padding(.leading, -4)
        .accessibilityLabel("Cancel")
        #else
        Button("Cancel") { dismiss() }
        #endif
    }

    private var editor: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: sessionProjection.binding(
                $prompt,
                titleGeneration: TranscriptLinks.shared.generation,
                refreshTitles: !promptFocused
            ))
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 11)
                .padding(.top, 8)
                .focused($promptFocused)
                // Cmd+V with a copied screenshot attaches it; text pastes
                // flow through to the editor untouched.
                .pastesImages(into: $images)
            if prompt.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("What should this session do?")
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .allowsHitTesting(false)
                    recipeButton
                }
                .padding(.horizontal, 16)
                .padding(.top, placeholderTopPadding)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        #if os(iOS)
        .contentShape(Rectangle())
        .onTapGesture { promptFocused = true }
        #endif
    }

    /// Offered only while the prompt is empty, under the placeholder it
    /// answers: a recipe is a way to START writing, and once there is
    /// something to send the button would be both in the way and destructive.
    private var recipeButton: some View {
        Button {
            promptFocused = false
            showLibrary = true
        } label: {
            Label("Start from a recipe", systemImage: "books.vertical")
                .font(.subheadline)
                .foregroundStyle(.tint)
                #if os(iOS)
                .frame(minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
                #endif
        }
        .buttonStyle(.plain)
    }

    /// Fill the composer from a library entry, leaving every field editable
    /// and the keyboard down: the point of prefilling rather than starting is
    /// that you read what will be sent, and a recipe prompt is longer than the
    /// two lines a raised keyboard leaves.
    private func apply(_ entry: LibraryEntry) {
        prompt = entry.prompt ?? ""
        if let entryMode = entry.mode, entryMode == "ask" || entryMode == "code" {
            selectMode(entryMode)
        }
        // Only a model this instance actually offers; a recipe naming one that
        // has since been retired keeps the composer's default instead.
        if let entryModel = entry.model, catalog?.option(for: entryModel) != nil {
            model = entryModel
            defaultEffortForCurrentModel()
        }
    }

    /// Lines the placeholder up with the editor's real text origin: the outer
    /// padding plus the platform text view's own insets. UITextView adds an
    /// 8pt top container inset (8 outer + 8 = 16); NSTextView adds none.
    /// Horizontally both add 5pt fragment padding (11 outer + 5 = 16).
    private var placeholderTopPadding: CGFloat {
        #if os(macOS)
        8
        #else
        16
        #endif
    }

    // ── Header: what the session is ───────────────────────────────────────

    /// Repo left, what-it's-created-from right, as on the desktop. These two
    /// decide what the session can touch, so they sit above the prompt rather
    /// than among the run settings below it.
    private var header: some View {
        HStack(spacing: 8) {
            repoChip
            Spacer(minLength: 8)
            modeChip
        }
        // 16, the column the prompt below already uses (11 outer + the text
        // view's own 5pt fragment padding) and the toolbar circles now sit on.
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    /// Sized off the chip's text rather than the tile's own default, so the
    /// icon reads as part of the label.
    private var repoTileSize: CGFloat {
        #if os(macOS)
        18
        #else
        16
        #endif
    }

    private var repoLabel: String {
        if repo == Session.noRepoID { return "No repo" }
        if let match = repos.first(where: { $0.id == repo }) {
            return match.label ?? match.id
        }
        return repo.isEmpty ? "No repository" : repo
    }

    private var repoChip: some View {
        Menu {
            ForEach(repos) { repoInfo in
                Button {
                    selectRepo(repoInfo.id)
                } label: {
                    Label {
                        Text(repoInfo.label ?? repoInfo.id)
                    } icon: {
                        // The checkmark takes the slot when it's the current
                        // repo — a menu row has one glyph, and which repo is
                        // selected outranks showing its icon twice (the chip
                        // above the menu already wears it).
                        if repo == repoInfo.id {
                            Image(systemName: "checkmark")
                        } else if let icon = RepoTile.menuIcon(for: repoInfo.id) {
                            icon
                        }
                    }
                }
            }
            if mode == "ask" {
                Divider()
                Button {
                    selectRepo(Session.noRepoID)
                } label: {
                    Label {
                        Text("No repo")
                    } icon: {
                        Image(systemName: repo == Session.noRepoID
                              ? "checkmark"
                              : "bubble.left.and.bubble.right")
                    }
                }
            }
        } label: {
            if repo == Session.noRepoID {
                chipLabel(
                    icon: "bubble.left.and.bubble.right",
                    text: repoLabel,
                    strong: true
                )
            } else if repo.isEmpty {
                chipLabel(icon: "folder", text: repoLabel, strong: true)
            } else {
                chipLabel(text: repoLabel, strong: true) {
                    RepoTile(name: repo, size: repoTileSize)
                }
            }
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .disabled(repos.isEmpty && mode != "ask")
    }

    /// Joining a workspace changes what code mode means: the session shares
    /// that workspace's worktree and branch rather than cutting a new one, so the
    /// chip says so instead of promising a branch it won't create.
    private var codeModeLabel: String {
        initialWorkspaceId == nil ? "New branch" : "Same branch"
    }

    /// The palette calls this "what to create from", and its two entries that
    /// exist here are a fresh branch (code) and Ask; the same words are used so
    /// the two screens describe one choice. Worktrees and scratch sessions have
    /// no native equivalent, so they aren't offered.
    private var modeChip: some View {
        Menu {
            Button {
                selectMode("code")
            } label: {
                Label {
                    Text(codeModeLabel)
                    Text(
                        initialWorkspaceId == nil
                            ? "Isolated worktree, can open a PR"
                            : "Shares this workspace's worktree"
                    )
                } icon: {
                    if mode == "code" { Image(systemName: "checkmark") }
                }
            }
            Button {
                selectMode("ask")
            } label: {
                Label {
                    Text("Ask")
                    Text("Read-only, no repo unless you pick one")
                } icon: {
                    if mode == "ask" { Image(systemName: "checkmark") }
                }
            }
        } label: {
            chipLabel(
                icon: mode == "code" ? "arrow.branch" : "text.magnifyingglass",
                text: mode == "code" ? codeModeLabel : "Ask"
            )
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    // ── Footer: how it runs ───────────────────────────────────────────────

    private var selectedModelOption: ModelOption? {
        catalog?.option(for: model)
    }

    private var effectiveModelID: String {
        model.isEmpty ? (catalog?.defaultModel ?? "") : model
    }

    private var currentEngine: String {
        catalog?.routingEngine(for: effectiveModelID)
            ?? ModelCatalog.engine(effectiveModelID)
    }

    private var engineChoices: [ModelEngineOption] {
        catalog?.availableEngines ?? []
    }

    private var availableEfforts: [String] {
        selectedModelOption?.efforts ?? []
    }

    private var fastSupported: Bool {
        selectedModelOption?.fastModeSupported == true
    }

    private var modelChipText: String {
        let id = model.isEmpty ? catalog?.defaultModel : model
        #if os(iOS)
        if id == "dial/opus-fable" { return "Opus/Fable/Oracle" }
        #endif
        return catalog?.label(for: id) ?? "Model"
    }

    /// Attach on the left, model on the right — the palette's footer. iOS folds
    /// reasoning effort and fast mode into the model menu, so the row stays two
    /// controls wide and needs no sideways scrolling; the Mac has the width to
    /// show them as their own chips.
    private var controls: some View {
        HStack(spacing: 8) {
            AttachImagesButton(images: $images)
            ComposerDictationButton(dictation: dictation, draft: $prompt)
            if !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                saveDraftButton
            }
            Spacer(minLength: 8)
            #if os(macOS)
            if !availableEfforts.isEmpty { effortChip }
            if fastSupported { fastChip }
            #endif
            if !sandboxChoices.isEmpty { sandboxChip }
            modelChip
        }
        .padding(.horizontal, 12)
        .padding(.vertical, controlsVerticalPadding)
    }

    private var saveDraftButton: some View {
        Button { saveDraft() } label: {
            chipLabel(
                icon: "square.and.arrow.down",
                text: savingDraft ? "Saving" : "Save draft"
            )
        }
        .buttonStyle(.plain)
        .disabled(savingDraft)
        .accessibilityLabel(savingDraft ? "Saving draft" : "Save as draft")
    }

    /// The iOS attach button carries its own 44pt tap target, so the row only
    /// needs air on the Mac.
    private var controlsVerticalPadding: CGFloat {
        #if os(macOS)
        10
        #else
        4
        #endif
    }

    /// Sandboxes this instance can actually start a session in. Empty on an
    /// instance that only runs on the host, and then the chip never appears:
    /// a picker with one entry is a label pretending to be a choice.
    private var sandboxChoices: [String] {
        if repo == Session.noRepoID { return [] }
        return SandboxOffering.choices(sandboxStatus)
    }

    /// Where the session runs. One chip, mirroring the server's own names for
    /// the providers. Choosing a Runner is not offered here — the web palette
    /// dropped that too, because a machine is picked for a piece of work, not
    /// for a message you have not written yet.
    private var sandboxChip: some View {
        Menu {
            sandboxOption(SandboxOffering.host)
            ForEach(sandboxChoices, id: \.self) { provider in
                sandboxOption(provider)
            }
        } label: {
            chipLabel(icon: "cube", text: SandboxOffering.label(sandbox))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    private func sandboxOption(_ provider: String) -> some View {
        Button {
            sandbox = provider
        } label: {
            if sandbox == provider {
                Label(SandboxOffering.label(provider), systemImage: "checkmark")
            } else {
                Text(SandboxOffering.label(provider))
            }
        }
    }

    private var modelChip: some View {
        Menu {
            #if os(iOS)
            if !availableEfforts.isEmpty {
                Section("Reasoning") {
                    ForEach(availableEfforts, id: \.self) { level in
                        Button {
                            effort = level
                        } label: {
                            if effort == level {
                                Label(EffortLevel.label(level), systemImage: "checkmark")
                            } else {
                                Text(EffortLevel.label(level))
                            }
                        }
                    }
                }
            }
            if fastSupported {
                Button {
                    fastMode.toggle()
                } label: {
                    if fastMode {
                        Label("Fast mode", systemImage: "checkmark")
                    } else {
                        Text("Fast mode")
                    }
                }
            }
            #endif
            if engineChoices.count > 1 {
                Section("Engine") {
                    ForEach(engineChoices) { engine in
                        engineButton(engine)
                    }
                }
            }
            if let catalog {
                if !catalog.presets.isEmpty {
                    Section("Presets") {
                        ForEach(catalog.presets) { option in
                            modelButton(option)
                        }
                    }
                }
                Section(catalog.presets.isEmpty ? "Model" : "Models") {
                    ForEach(catalog.regular) { option in
                        modelButton(option)
                    }
                }
            }
        } label: {
            chipLabel(
                icon: "cpu",
                text: modelChipText
            )
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    private func modelButton(_ option: ModelOption) -> some View {
        let routed = ModelCatalog.routedID(option.id, engine: currentEngine)
        return Button {
            selectModel(option)
        } label: {
            let selected = option.id == ModelCatalog.baseID(model)
            if let subtitle = option.description, !subtitle.isEmpty {
                Label {
                    Text(option.displayLabel)
                    Text(subtitle)
                } icon: {
                    if selected { Image(systemName: "checkmark") }
                }
            } else if selected {
                Label(option.displayLabel, systemImage: "checkmark")
            } else {
                Text(option.displayLabel)
            }
        }
        .disabled(routed == nil)
    }

    private func engineButton(_ engine: ModelEngineOption) -> some View {
        let routed = ModelCatalog.routedID(effectiveModelID, engine: engine.id)
        return Button {
            guard let routed else { return }
            model = routed
        } label: {
            if currentEngine == engine.id {
                Label(engine.label, systemImage: "checkmark")
            } else {
                Text(engine.label)
            }
        }
        .disabled(routed == nil)
    }

    private var effortChip: some View {
        Menu {
            ForEach(availableEfforts, id: \.self) { level in
                Button {
                    effort = level
                } label: {
                    if effort == level {
                        Label(EffortLevel.label(level), systemImage: "checkmark")
                    } else {
                        Text(EffortLevel.label(level))
                    }
                }
            }
        } label: {
            chipLabel(
                icon: "gauge.with.needle",
                text: effort.isEmpty ? "Effort" : EffortLevel.label(effort)
            )
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    private var fastChip: some View {
        Button {
            fastMode.toggle()
        } label: {
            chipLabel(icon: "bolt.fill", text: "Fast", highlighted: fastMode)
        }
        .buttonStyle(.plain)
    }

    /// `strong` is the repo's treatment: full-strength ink, as the desktop
    /// palette gives its repository trigger — the one choice on the screen you
    /// should be able to read without looking for it.
    private func chipLabel(
        icon: String, text: String, highlighted: Bool = false, strong: Bool = false
    ) -> some View {
        chipLabel(text: text, highlighted: highlighted, strong: strong) {
            Image(systemName: icon)
                #if os(iOS)
                .font(.caption2)
                #else
                .font(.caption)
                #endif
        }
    }

    /// Same chip with a view in the glyph's place, so the repo can wear its
    /// own icon rather than a folder standing in for it.
    private func chipLabel<Icon: View>(
        text: String,
        highlighted: Bool = false,
        strong: Bool = false,
        @ViewBuilder icon: () -> Icon
    ) -> some View {
        HStack(spacing: 5) {
            icon()
            Text(text)
                #if os(iOS)
                .font(.caption.weight(strong ? .medium : .regular))
                #else
                .font(.callout.weight(strong ? .medium : .regular))
                #endif
                .lineLimit(1)
        }
        .foregroundStyle(
            highlighted
                ? AnyShapeStyle(.tint)
                : (strong ? AnyShapeStyle(OS1VisualStyle.text) : AnyShapeStyle(.secondary))
        )
        #if os(iOS)
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        #else
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        #endif
        .background(
            highlighted ? AnyShapeStyle(.tint.opacity(0.15)) : AnyShapeStyle(.fill.tertiary),
            in: Capsule()
        )
        #if os(iOS)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        #else
        .contentShape(Capsule())
        #endif
    }

    // ── Data ──────────────────────────────────────────────────────────────

    private func load() async {
        if prompt.isEmpty, let initialDraft { prompt = initialDraft.text }
        promptFocused = true
        // Opened from the Action Button: the mic goes hot with the sheet, so
        // speaking is the first thing that works. Everything else below still
        // loads underneath it. Only once the permissions exist, though — the
        // first press should show the composer, not two system prompts stacked
        // over it; the mic in the footer asks for them on the first tap.
        if autoDictate, !dictation.active, Dictation.isAuthorized {
            Task { await dictation.start(base: prompt) { prompt = $0 } }
        }
        repo = initialRepo ?? lastRepo
        if repo == Session.noRepoID { mode = "ask" }
        async let reposFetch = OS1API.repos()
        async let modelsFetch = OS1API.models(workspaceId: initialWorkspaceId)
        // A server without sandboxes, or one too old to answer, simply leaves
        // the chip off. It must never keep the composer from opening.
        async let sandboxFetch = OS1API.sandboxStatus()
        repos = (try? await reposFetch) ?? []
        if repo != Session.noRepoID,
           !repos.isEmpty,
           !repos.contains(where: { $0.id == repo }) {
            repo = repos.first(where: { $0.isDefault == true })?.id ?? repos[0].id
        }
        // The picker's rows can only show an icon the cache already holds, so
        // fetch them here rather than when the menu opens.
        for repoInfo in repos { RepoTile.prefetchIcon(for: repoInfo.id) }
        sandboxStatus = try? await sandboxFetch
        if let fetched = try? await modelsFetch {
            catalog = fetched
            let livePrefs = try? await SettingsAPI.uiPrefs(
                user: ServerConfig.shared.userName
            )
            let livePreferred = livePrefs?["default-model"] ?? preferredModel
            let liveEngine = livePrefs?["default-engine"] ?? preferredEngine
            preferredModel = livePreferred
            preferredEngine = liveEngine
            if model.isEmpty {
                let start = fetched.option(for: livePreferred) != nil
                    ? livePreferred
                    : (fetched.defaultModel ?? "")
                // Start on their default engine too. It then stays with the
                // composer: selectModel recomposes onto currentEngine.
                model = fetched.preferredID(start, engine: liveEngine)
            }
            defaultEffortForCurrentModel()
        }
    }

    private func selectModel(_ option: ModelOption) {
        guard let routed = ModelCatalog.routedID(option.id, engine: currentEngine) else {
            return
        }
        model = routed
        defaultEffortForCurrentModel()
        if !(option.fastModeSupported == true) { fastMode = false }
    }

    /// "High" is the palette's default where supported; presets (dial) have
    /// no effort dimension so the chip hides.
    private func defaultEffortForCurrentModel() {
        let efforts = availableEfforts
        if efforts.isEmpty {
            effort = ""
        } else if !efforts.contains(effort) {
            effort = efforts.contains("high") ? "high" : efforts[0]
        }
    }

    /// Match the web palette's two-axis create: a universal Ask starts with no
    /// repo, while a repo-scoped "+" keeps that repository. Switching back to
    /// Code restores the most recent real repository.
    private func selectMode(_ selected: String) {
        mode = selected
        repo = Self.repoAfterSelectingMode(
            selected,
            current: repo,
            isRepoScoped: initialRepo != nil,
            fallback: fallbackRepo
        )
    }

    static func repoAfterSelectingMode(
        _ mode: String,
        current: String,
        isRepoScoped: Bool,
        fallback: String
    ) -> String {
        if mode == "ask", !isRepoScoped { return Session.noRepoID }
        if mode == "code", current == Session.noRepoID { return fallback }
        return current
    }

    private func selectRepo(_ selected: String) {
        repo = selected
        if selected == Session.noRepoID {
            mode = "ask"
        } else {
            lastRepo = selected
        }
    }

    private var fallbackRepo: String {
        if repos.contains(where: { $0.id == lastRepo }) { return lastRepo }
        return repos.first(where: { $0.isDefault == true })?.id ?? repos.first?.id ?? ""
    }

    private func saveDraft() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !savingDraft else { return }
        dictation.stop()
        savingDraft = true
        Task {
            defer { savingDraft = false }
            do {
                let workspace = try await OS1API.saveWorkspaceDraft(
                    text: text,
                    repo: repo,
                    workspaceId: initialWorkspaceId,
                    autoName: initialDraft?.autoName
                )
                onDraftSaved(workspace)
                dismiss()
            } catch {
                draftSaveError = error.localizedDescription
            }
        }
    }

    /// Optimistic create: the sheet closes immediately and the conversation
    /// opens seeded with the prompt under a temporary id, while the real
    /// create (worktree prep — seconds) runs in the background. The list
    /// swaps the temp id for the server's when it resolves.
    private func create() {
        guard !savingDraft else { return }
        // Played here rather than from a trigger on the view: the sheet
        // dismisses two lines down, and a dismissed view never observes its
        // own state change. Starting a session is the same gesture as sending
        // a message, and wears the same disc — so it gets the same cue.
        Haptics.play(.send)
        dictation.stop()
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageURLs = images.map(\.dataURL)
        if repo != Session.noRepoID { lastRepo = repo }
        let pending = Session.optimistic(
            id: "pending-\(UUID().uuidString)",
            title: String((text.components(separatedBy: "\n").first ?? text).prefix(80)),
            repo: repo,
            repoLess: repo == Session.noRepoID,
            mode: mode,
            model: model.isEmpty ? nil : model,
            effort: effort.isEmpty ? nil : effort,
            fastMode: fastMode,
            startedBy: ServerConfig.shared.userName,
            workspaceId: initialWorkspaceId
        )
        dismiss()
        onCreated(
            pending,
            SessionViewModel.OptimisticSeed(prompt: text, images: imageURLs)
        )
        Task {
            do {
                let id = try await OS1API.createSession(
                    prompt: text,
                    repo: repo,
                    mode: mode,
                    model: model.isEmpty ? nil : model,
                    effort: effort.isEmpty ? nil : effort,
                    fastMode: fastMode,
                    images: imageURLs,
                    workspaceId: initialWorkspaceId,
                    // Only when the chip was on screen. Where it wasn't, the
                    // instance keeps deciding, exactly as before.
                    // Remote providers materialize a repository workspace, so
                    // an explicit no-repo Ask must stay on the host even when
                    // the instance has a remote sandbox default.
                    sandbox: repo == Session.noRepoID
                        ? SandboxOffering.createValue(SandboxOffering.host)
                        : (sandboxChoices.isEmpty
                            ? nil
                            : SandboxOffering.createValue(sandbox))
                )
                onResolved(pending.id, .success(id))
            } catch {
                onResolved(pending.id, .failure(error))
            }
        }
    }
}
