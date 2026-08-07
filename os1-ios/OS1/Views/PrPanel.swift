import SwiftUI

/// Toolbar chip for a session's PR: the number plus one status dot — merged /
/// closed / draft, or the check rollup while open. Tapping it opens PrPanelView.
struct PrChipLabel: View {
    let number: Int
    /// nil while only the sessions-list snapshot is known (details still
    /// loading) — the dot goes neutral rather than guessing a check state.
    let summary: PrDetails.Summary?

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(summary.map { $0.color } ?? Color.secondary)
                .frame(width: 7, height: 7)
            Text(verbatim: "#\(number)")
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
        }
    }
}

extension PrDetails.Summary {
    var color: Color {
        switch self {
        case .merged: .purple
        case .closed: .red
        case .draft: .gray
        case .failing: .red
        case .pending: .orange
        case .passing: .green
        }
    }

    var label: String {
        switch self {
        case .merged: "Merged"
        case .closed: "Closed"
        case .draft: "Draft"
        case .failing: "Checks failing"
        case .pending: "Checks running"
        case .passing: "Open"
        }
    }
}

/// The PR details sheet: title, state and review badges, branch/line stats,
/// conflict warning, every check with its status, and the reviewer list.
/// Read-only by design — actions (merge, review, comment) stay on the web UI.
struct PrPanelView: View {
    var viewModel: SessionViewModel
    /// How this is being shown. `.pushed` brings no chrome of its own: the
    /// navigation stack is already there, and the way out is the chevron (or
    /// the edge swipe) rather than a Done button.
    var chrome: Chrome = .sheet
    @Environment(\.dismiss) private var dismiss

    enum Chrome { case sheet, pushed }

    var body: some View {
        Group {
            switch chrome {
            case .sheet:
                NavigationStack {
                    titled(content)
                        .toolbar {
                            ToolbarItem(placement: .topTrailingCompat) {
                                Button("Done") { dismiss() }
                            }
                        }
                }
            case .pushed:
                titled(content)
            }
        }
        // Checks move fast while CI runs; re-fetch on open (server-cached).
        .task { await viewModel.refreshPr() }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 540)
        #endif
    }

    private func titled(_ view: some View) -> some View {
        // `Text(verbatim:)`, not a bare interpolation: inferred as a
        // LocalizedStringKey, "PR #\(number)" runs the number through the
        // device's locale — #5555 renders "PR #5.555" anywhere that groups
        // thousands with a dot. Same reason the overflow menu spells its PR
        // row verbatim.
        view
            .navigationTitle(
                Text(verbatim: viewModel.prDetails.map { "PR #\($0.number)" } ?? "Pull request")
            )
            .inlineTitleBarCompat()
    }

    @ViewBuilder
    private var content: some View {
        if let pr = viewModel.prDetails {
            List {
                overviewSection(pr)
                checksSection(pr)
                reviewersSection(pr)
            }
            .insetGroupedListCompat()
            #if os(iOS)
            .scrollContentBackground(.hidden)
            .background(OS1VisualStyle.background)
            #endif
            .refreshable { await viewModel.refreshPr() }
        } else if viewModel.prLoadFailed {
            ContentUnavailableView {
                Label("Couldn't load the pull request", systemImage: "exclamationmark.triangle")
            } description: {
                Text("GitHub may be rate-limited right now — try again in a moment.")
            } actions: {
                Button("Retry") { viewModel.loadPr() }
            }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func overviewSection(_ pr: PrDetails) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(pr.title ?? "Untitled")
                    .font(.headline)
                HStack(spacing: 6) {
                    badge(pr.summary.label, color: pr.summary.color)
                    if let decision = reviewBadge(pr.reviewDecision) {
                        badge(decision.label, color: decision.color)
                    }
                }
                VStack(alignment: .leading, spacing: 3) {
                    if let author = pr.author, !author.isEmpty {
                        metaText("Opened by \(author)")
                    }
                    if let head = pr.headRefName, let base = pr.baseRefName {
                        metaText("\(head) → \(base)")
                    }
                    metaText(
                        "+\(pr.additions ?? 0) −\(pr.deletions ?? 0) in "
                            + "\(pr.changedFiles ?? 0) file\((pr.changedFiles ?? 0) == 1 ? "" : "s")"
                    )
                }
                if pr.mergeable == "CONFLICTING" {
                    Label(
                        "Has conflicts with \(pr.baseRefName ?? "the base branch")",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.footnote)
                    .foregroundStyle(.orange)
                }
            }
            .padding(.vertical, 2)
            if let url = pr.url.flatMap(URL.init) {
                Link(destination: url) {
                    Label("Open on GitHub", systemImage: "arrow.up.right")
                }
            }
        }
    }

    @ViewBuilder
    private func checksSection(_ pr: PrDetails) -> some View {
        let checks = pr.checks ?? []
        Section(checksHeader(checks)) {
            if checks.isEmpty {
                Text("No checks reported")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(checks.enumerated()), id: \.offset) { _, check in
                    if let url = check.url.flatMap(URL.init) {
                        Link(destination: url) { checkRow(check) }
                            .foregroundStyle(.primary)
                    } else {
                        checkRow(check)
                    }
                }
            }
        }
    }

    private func checksHeader(_ checks: [PrCheck]) -> String {
        guard !checks.isEmpty else { return "Checks" }
        let passed = checks.filter { $0.rank == .success }.count
        return "Checks · \(passed)/\(checks.count) passed"
    }

    private func checkRow(_ check: PrCheck) -> some View {
        HStack(spacing: 10) {
            checkIcon(check.rank)
            VStack(alignment: .leading, spacing: 1) {
                Text(check.name)
                    .font(.subheadline)
                    .lineLimit(1)
                if let workflow = check.workflowName, !workflow.isEmpty {
                    Text(workflow)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if let duration = checkDuration(check) {
                Text(duration)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
    }

    @ViewBuilder
    private func checkIcon(_ rank: PrCheck.Rank) -> some View {
        switch rank {
        case .success:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failure:
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        case .pending:
            Image(systemName: "clock.fill").foregroundStyle(.orange)
        case .neutral:
            Image(systemName: "minus.circle").foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func reviewersSection(_ pr: PrDetails) -> some View {
        if let reviewers = pr.reviewers, !reviewers.isEmpty {
            Section("Reviewers") {
                ForEach(Array(reviewers.enumerated()), id: \.offset) { _, reviewer in
                    HStack {
                        Text(reviewer.isTeam == true ? "@\(reviewer.login) (team)" : reviewer.login)
                            .font(.subheadline)
                        Spacer()
                        if let state = reviewerBadge(reviewer.state) {
                            Text(state.label)
                                .font(.caption)
                                .foregroundStyle(state.color)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Small pieces

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }

    private func metaText(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
    }

    private func reviewBadge(_ decision: String?) -> (label: String, color: Color)? {
        switch decision ?? "" {
        case "APPROVED": ("Approved", .green)
        case "CHANGES_REQUESTED": ("Changes requested", .red)
        case "REVIEW_REQUIRED": ("Review required", .orange)
        default: nil
        }
    }

    private func reviewerBadge(_ state: String?) -> (label: String, color: Color)? {
        switch state ?? "" {
        case "APPROVED": ("Approved", .green)
        case "CHANGES_REQUESTED": ("Changes requested", .red)
        case "COMMENTED": ("Commented", .secondary)
        case "DISMISSED": ("Dismissed", .secondary)
        case "PENDING": ("Requested", .orange)
        default: nil
        }
    }

    private func checkDuration(_ check: PrCheck) -> String? {
        guard let started = Session.parseISO(check.startedAt),
              let completed = Session.parseISO(check.completedAt) else { return nil }
        let secs = Int(completed.timeIntervalSince(started).rounded())
        guard secs > 0 else { return nil }
        if secs < 60 { return "\(secs)s" }
        return "\(Int((Double(secs) / 60).rounded()))m"
    }
}
