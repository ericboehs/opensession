import SwiftUI

/// A shell in the session's worktree, shaped for a phone.
///
/// Not a terminal emulator, on purpose. A full one needs a software keyboard
/// with a control row, and at that point asking the agent to run the command
/// is both faster and better, which is why the web viewer hides its own
/// terminal below tablet width. What a phone is genuinely good at is the other
/// half of the same need: run one short command and read the answer, or point
/// something at a live log and watch it arrive. So this is an output view with
/// one line of input, and the deliberate omissions (no control-key row, no tab
/// completion, no second shell) are what keep it that.
///
/// The scroll behaviour is the transcript's, through the same
/// `TranscriptScroll.isNearBottom` predicate: output follows you while you are
/// at the end, and stops following the moment you scroll up to read something.
struct TerminalView: View {
    @State private var model: TerminalViewModel
    @State private var draft = ""
    @FocusState private var inputFocused: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(sessionId: String) {
        _model = State(initialValue: TerminalViewModel(sessionId: sessionId))
    }

    /// Test and preview seam: a scripted socket instead of a real shell.
    init(model: TerminalViewModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        VStack(spacing: 0) {
            output
            Divider()
            commandField
        }
        .background(OS1VisualStyle.codeWell)
        .navigationTitle("Terminal")
        .inlineTitleBarCompat()
        .toolbar { toolbarItems }
        // Started here rather than in `init`: a panel that is pushed and
        // popped should open exactly one shell, and `init` runs whenever
        // SwiftUI feels like rebuilding the struct. The model makes this
        // idempotent, so it does not matter whether the first width
        // measurement arrives before or after this.
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    // MARK: - Output

    private var output: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(model.lines) { line in
                        TerminalLineRow(line: line)
                            .id(line.id)
                    }
                    // A zero-height anchor to scroll to: aiming at the last
                    // LINE would stop one row short whenever that row is tall.
                    Color.clear
                        .frame(height: 1)
                        .id(TerminalView.tailAnchor)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboardCompat()
            .textSelection(.enabled)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                TranscriptScroll.isNearBottom(
                    TranscriptScroll.Geometry(
                        visibleMaxY: geometry.visibleRect.maxY,
                        contentHeight: geometry.contentSize.height,
                        insetBottom: geometry.contentInsets.bottom,
                        containerHeight: geometry.containerSize.height
                    ),
                    // Tighter than the transcript's: rows here are one line
                    // tall, so "near the end" is a couple of lines, not a
                    // couple of messages.
                    tolerance: 24
                )
            } action: { _, isNearBottom in
                model.isPinnedToBottom = isNearBottom
                if isNearBottom { model.hasUnseenOutput = false }
            }
            .onChange(of: model.lines.count) {
                guard model.isPinnedToBottom else { return }
                proxy.scrollTo(TerminalView.tailAnchor, anchor: .bottom)
            }
            .onChange(of: model.state) {
                // A shell that just came up, or just died, is worth landing on.
                proxy.scrollTo(TerminalView.tailAnchor, anchor: .bottom)
            }
            .overlay(alignment: .bottomTrailing) {
                // The control is always present and fades itself, rather than
                // being inserted and removed under an `.animation` on the
                // scroll view. The container spelling reads more naturally and
                // it is what crashed: an implicit animation there wraps every
                // row, and with output arriving several times a second the
                // retain count overflowed inside SwiftUI's animation combining
                // (SIGABRT in swift_abortRetainOverflow, by way of
                // combineAnimation and AnimatableFrameAttribute, about 80
                // seconds into a live `tail -f`). Keep any animation on this
                // surface scoped to the smallest view that needs it.
                ScrollToLatestButton(hasNewOutput: model.hasUnseenOutput) {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(TerminalView.tailAnchor, anchor: .bottom)
                    }
                    model.isPinnedToBottom = true
                    model.hasUnseenOutput = false
                }
                .padding(.trailing, 14)
                .padding(.bottom, 12)
                .opacity(model.isPinnedToBottom ? 0 : 1)
                .scaleEffect(model.isPinnedToBottom ? 0.9 : 1)
                .animation(.easeOut(duration: 0.18), value: model.isPinnedToBottom)
                .allowsHitTesting(!model.isPinnedToBottom)
            }
            .overlay(alignment: .top) { banner }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                // The shell wraps at the width it believes it has. Telling it
                // the truth is the only geometry this surface negotiates.
                let columns = Int((width - 24) / TerminalLineRow.characterWidth)
                guard columns > 0 else { return }
                model.setColumns(columns)
            }
        }
    }

    /// Where the shell landed, or why it is not there any more. One line, dim,
    /// gone as soon as the shell is simply working.
    @ViewBuilder
    private var banner: some View {
        switch model.state {
        case .connecting:
            bannerLabel("Opening a shell…", tone: OS1VisualStyle.textDim)
        case .running(let target, let cwd):
            if target != "host" {
                bannerLabel("Running in the \(target) sandbox · \(cwd)", tone: OS1VisualStyle.textDim)
            }
        case .ended:
            bannerLabel("The shell closed. Leave and come back to open another.", tone: OS1VisualStyle.textDim)
        case .failed(let reason):
            // The palette's red rather than the visual style's: that one is a
            // single value used in both appearances, and this banner sits on
            // the code well, where it needs the light-appearance step.
            bannerLabel(reason, tone: TerminalPalette.color(for: .indexed(1), dim: false))
        }
    }

    private func bannerLabel(_ text: String, tone: Color) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(tone)
            // Two lines hold every banner at the default size. At an
            // accessibility size the longest of them ("The shell closed…")
            // needs four, and the sentence it cuts is the one telling you how
            // to get another shell. A banner is transient, so the height it
            // takes to say that is cheaper than the truncation.
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.thinMaterial)
    }

    // MARK: - Input

    private var commandField: some View {
        HStack(spacing: 8) {
            if !model.history.isEmpty {
                // The phone's answer to tab completion and to a shell's
                // history keys, neither of which exist without a hardware
                // keyboard. Retyping is the expensive part here, so the
                // commands you already ran are one tap away.
                Menu {
                    ForEach(model.history.reversed(), id: \.self) { command in
                        Button(command) { draft = command }
                    }
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 16))
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .frame(width: 30, height: 30)
                }
                .accessibilityLabel("Recent commands")
            }

            TextField("Run a command", text: $draft)
                .font(.system(size: 15, design: .monospaced))
                .textFieldStyle(.plain)
                .focused($inputFocused)
                .noAutocapitalizationCompat()
                .autocorrectionDisabled()
                .submitLabel(.send)
                .onSubmit(send)
                .disabled(!isLive)

            if isLive {
                // ^C, and only ^C. Starting something endless is the normal
                // case on this surface (`tail -f`, a dev server), so there has
                // to be a way back that is not "close the panel". One
                // button is not a control-key row.
                Button {
                    model.interrupt()
                } label: {
                    Text("Stop")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.textDim)
                        // The only label on this row that scales: the field is
                        // a fixed 15pt monospace because what you type has to
                        // match the output above it, and the two glyphs are
                        // drawn at a fixed size. Left to grow, "Stop" reaches
                        // the width of the field itself at AX5 and there is
                        // nowhere left to type. Capped, it stays a word.
                        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                }
                .accessibilityLabel("Send interrupt")
            }

            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 26))
                    .foregroundStyle(
                        canSend ? OS1VisualStyle.accent : OS1VisualStyle.textDim.opacity(0.5)
                    )
            }
            .disabled(!canSend)
            .accessibilityLabel("Run")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(OS1VisualStyle.panel)
    }

    @ToolbarContentBuilder
    private var toolbarItems: some ToolbarContent {
        ToolbarItem(placement: .topTrailingCompat) {
            Menu {
                Button {
                    copyToPasteboard(model.plainText)
                } label: {
                    Label("Copy all output", systemImage: "doc.on.doc")
                }
                Button {
                    model.clear()
                } label: {
                    Label("Clear", systemImage: "eraser")
                }
                // Only once there is nothing to type at: a shell that ended
                // or a connection that dropped otherwise leaves the field
                // disabled with no way back short of leaving the panel.
                if !isLive {
                    Button {
                        model.restart()
                    } label: {
                        Label("Start a new shell", systemImage: "arrow.clockwise")
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel("Terminal options")
        }
    }

    private var isLive: Bool { model.isLive }

    private var canSend: Bool {
        isLive && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard canSend else { return }
        model.run(draft)
        draft = ""
        // The keyboard stays: the next command usually follows the last one.
        inputFocused = true
    }

    private static let tailAnchor = "terminal-tail"
}

/// One line of output.
///
/// Built as a single `Text` from concatenated runs rather than an `HStack` of
/// them, so a long line wraps as one paragraph and a selection can run across
/// a colour change.
private struct TerminalLineRow: View {
    let line: TerminalLine

    /// The advance of the monospaced font below, measured once. Used to tell
    /// the shell how many columns it has.
    static let characterWidth: CGFloat = {
        let font = PlatformFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        return ("0" as NSString).size(withAttributes: [.font: font]).width
    }()

    var body: some View {
        Text(attributed)
            .font(.system(size: 12, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            // An empty line is still a line: without a floor, blank output
            // collapses and the spacing of what surrounds it changes.
            .frame(minHeight: 15, alignment: .leading)
    }

    private var attributed: AttributedString {
        var result = AttributedString()
        for run in line.runs {
            var piece = AttributedString(run.text)
            piece.foregroundColor = TerminalPalette.color(for: run.style.ink, dim: run.style.dim)
            if run.style.bold {
                piece.font = .system(size: 12, weight: .semibold, design: .monospaced)
            }
            result.append(piece)
        }
        return result
    }
}
