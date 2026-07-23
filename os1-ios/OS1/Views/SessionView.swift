import SwiftUI

struct SessionView: View {
    @State private var viewModel: SessionViewModel
    @FocusState private var inputFocused: Bool

    init(session: Session) {
        _viewModel = State(initialValue: SessionViewModel(session: session))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(viewModel.entries) { entry in
                        TranscriptRow(entry: entry)
                            .id(entry.id)
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
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: viewModel.entries.count) {
                scrollToBottom(proxy, animated: true)
            }
            .onChange(of: viewModel.liveText) {
                scrollToBottom(proxy, animated: false)
            }
            .onChange(of: viewModel.pendingQuestion) {
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
            HStack(spacing: 6) {
                if viewModel.isRunning {
                    Label("Running", systemImage: "circle.fill")
                        .foregroundStyle(.green)
                }
                if viewModel.queuedCount > 0 {
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

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        let target: String
        if viewModel.pendingQuestion != nil {
            target = "ask-\(viewModel.pendingQuestion!.id)"
        } else if viewModel.isStreaming || !viewModel.liveText.isEmpty {
            target = "live-stream"
        } else if let last = viewModel.entries.last {
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
