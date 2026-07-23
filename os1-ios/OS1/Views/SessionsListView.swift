import SwiftUI

struct SessionsListView: View {
    @State private var viewModel = SessionsListViewModel()
    @State private var showSettings = false
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if !viewModel.hasLoaded {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if viewModel.sessions.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("Sessions")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
            .safeAreaInset(edge: .bottom) {
                if let error = viewModel.error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.white)
                        .padding(8)
                        .frame(maxWidth: .infinity)
                        .background(.red.opacity(0.85))
                }
            }
        }
        .task {
            viewModel.startPolling()
        }
        .onDisappear {
            viewModel.stopPolling()
        }
        .onChange(of: viewModel.hasLoaded) {
            autoOpenFromEnvironment()
        }
    }

    /// Dev convenience for simulator runs: OS1_OPEN_SESSION=<id> jumps straight
    /// into that session once the list has loaded.
    private func autoOpenFromEnvironment() {
        guard path.isEmpty,
              let id = ProcessInfo.processInfo.environment["OS1_OPEN_SESSION"],
              let session = viewModel.sessions.first(where: { $0.id == id })
        else { return }
        path.append(session)
    }

    private var list: some View {
        List(viewModel.sessions) { session in
            NavigationLink(value: session) {
                SessionRow(session: session)
            }
        }
        .listStyle(.plain)
        .refreshable {
            await viewModel.refresh()
        }
        .navigationDestination(for: Session.self) { session in
            SessionView(session: session)
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No sessions", systemImage: "bubble.left.and.bubble.right")
        } description: {
            Text(viewModel.error ?? "Sessions from the OS1 server will appear here.")
        } actions: {
            Button("Settings") { showSettings = true }
        }
    }
}

struct SessionRow: View {
    let session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                statusDot
                Text(session.displayTitle)
                    .font(.body.weight(.medium))
                    .lineLimit(2)
            }
            HStack(spacing: 6) {
                if let repo = session.repo {
                    Text(repo)
                }
                if let branch = session.branch {
                    Text(branch)
                        .lineLimit(1)
                }
                if session.queuedCount ?? 0 > 0 {
                    Text("+\(session.queuedCount!) queued")
                }
                Spacer()
                if let date = session.lastActivityDate {
                    Text(date, format: .relative(presentation: .named))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private var statusDot: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 8, height: 8)
    }

    private var statusColor: Color {
        switch session.status {
        case .needsInput: .orange
        case .running: .green
        case .idle: .secondary.opacity(0.4)
        }
    }
}
