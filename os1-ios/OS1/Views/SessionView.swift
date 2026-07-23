import SwiftUI

struct SessionView: View {
    @State private var viewModel: SessionViewModel
    @FocusState private var inputFocused: Bool
    @Environment(\.scenePhase) private var scenePhase

    init(session: Session) {
        _viewModel = State(initialValue: SessionViewModel(session: session))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(viewModel.displayItems) { item in
                        TranscriptRow(item: item)
                            .id(item.id)
                    }
                    if viewModel.isStreaming || !viewModel.liveText.isEmpty {
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
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            // Initial render lands at the bottom, and `.sizeChanges` KEEPS it
            // pinned there through everything that used to leave the list
            // stranded mid-scroll: the staged transcript prepending ~100
            // entries above the first-paint head (which never changed
            // `last?.id`, so no manual scroll fired), lazy rows settling
            // their real heights, and streaming growth. The pin releases
            // when the person scrolls up to read — no yanking them back.
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: viewModel.pendingQuestion) {
                // A question needs eyes even if they've scrolled away.
                scrollToBottom(proxy, animated: true)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            statusBanner
        }
        .safeAreaInset(edge: .bottom) {
            inputBar
        }
        .navigationTitle(viewModel.session.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if viewModel.isRunning {
                ToolbarItem(placement: .topBarTrailing) {
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

    private func bannerText(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(color)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity)
            .background(.bar)
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
            HStack(spacing: 6) {
                if viewModel.isRunning {
                    Label("Running", systemImage: "circle.fill")
                        .foregroundStyle(.green)
                }
                if viewModel.queuedCount > 0, viewModel.queuedItems.isEmpty {
                    // Pre-handshake count from the sessions list, before the
                    // watch delivers the actual items.
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
            .padding(.horizontal, 4)

            HStack(alignment: .bottom, spacing: 8) {
                TextField(
                    viewModel.isRunning ? "Message (queued)" : "Message",
                    text: $viewModel.draft,
                    axis: .vertical
                )
                .lineLimit(1...5)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 18))
                .focused($inputFocused)

                Button {
                    viewModel.sendDraft()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                }
                .disabled(!viewModel.canSend)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

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
            .background(
                .fill.tertiary,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        let target: String
        if viewModel.pendingQuestion != nil {
            target = "ask-\(viewModel.pendingQuestion!.id)"
        } else if viewModel.isStreaming || !viewModel.liveText.isEmpty {
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
