import SwiftUI

/// The subscription accounts runs draw from, and how close each one is to its
/// limit. Rendered inside Settings → Providers, matching the web
/// (ProvidersPanel.tsx).
///
/// The list and the meters live together because the answer to "this one is
/// spent" is an action on the row: hand it an owner, sign it in again, or take
/// it out of the pool.
struct ProviderAccountSections: View {
    /// Bumped by the enclosing pane's pull-to-refresh; re-runs `task`.
    var reload: Int
    @State private var claude: [ProviderAccount]
    @State private var codex: [ProviderAccount]
    @State private var loaded: Bool
    @State private var loading = true
    @State private var error: String?
    @State private var showingAdd: AccountKind?
    @State private var removal: AccountRemoval?
    @State private var codexLoginSheet = false

    /// Seeded from the last answer this device saw, so re-entering Providers
    /// shows the pools straight away and the fetch behind it only corrects them.
    init(reload: Int) {
        self.reload = reload
        let cachedClaude: [ProviderAccount] = SettingsCache.value("claude-accounts") ?? []
        let cachedCodex: [ProviderAccount] = SettingsCache.value("codex-accounts") ?? []
        _claude = State(initialValue: cachedClaude)
        _codex = State(initialValue: cachedCodex)
        _loaded = State(initialValue: cachedClaude.isEmpty == false || cachedCodex.isEmpty == false)
    }

    var body: some View {
        Section("Accounts") {
            if loading, loaded == false {
                settingsLoadingRow
            } else if let error, loaded == false {
                settingsErrorRow(error) { Task { await load() } }
            } else {
                if let error { settingsErrorRow(error) { Task { await load() } } }
                if accountItems.isEmpty {
                    Text("No accounts yet. Runs use this server's Claude and Codex sign-ins until you add an Anthropic or OpenAI account.")
                        .foregroundStyle(.secondary)
                }
                ForEach(accountItems) { item in
                    AccountUsageRow(
                        account: item.account,
                        kind: item.kind,
                        onToggleOwnership: { Task { await toggleOwnership(item.account, kind: item.kind) } },
                        onRemove: {
                            removal = AccountRemoval(
                                id: item.account.id ?? "",
                                name: item.account.name ?? "this account",
                                kind: item.kind
                            )
                        }
                    )
                }
                Menu {
                    Button("Claude account") { showingAdd = .claude }
                    Button("OpenAI API key") { showingAdd = .codex }
                } label: {
                    Label("Add account", systemImage: "plus")
                }
                Button("Refresh account usage") { Task { await refreshAccounts() } }
                Button { codexLoginSheet = true } label: {
                    Label("Sign in with ChatGPT", systemImage: "person.badge.key")
                }
            }
        }
        .task(id: reload) { await load() }
        .sheet(item: $showingAdd) { kind in
            AccountEditor(kind: kind) { name, value, owner in
                await addAccount(kind: kind, name: name, value: value, owner: owner)
            }
        }
        .sheet(isPresented: $codexLoginSheet) {
            CodexDeviceLoginView {
                codexLoginSheet = false
                await load()
            }
        }
        .alert(
            "Remove account?",
            isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }),
            presenting: removal
        ) { target in
            Button("Remove", role: .destructive) { Task { await remove(target) } }
            Button("Cancel", role: .cancel) {}
        } message: { target in
            Text("Remove \(target.name) from the \(target.kind.rawValue) account pool?")
        }
    }

    private var validClaude: [ProviderAccount] { claude.filter { $0.id?.isEmpty == false } }
    private var validCodex: [ProviderAccount] { codex.filter { $0.id?.isEmpty == false } }
    private var accountItems: [ProviderAccountItem] {
        let claudeItems = validClaude
            .sorted { ($0.name ?? "").localizedCaseInsensitiveCompare($1.name ?? "") == .orderedAscending }
            .map { ProviderAccountItem(account: $0, kind: .claude) }
        let codexItems = validCodex
            .sorted { ($0.name ?? "").localizedCaseInsensitiveCompare($1.name ?? "") == .orderedAscending }
            .map { ProviderAccountItem(account: $0, kind: .codex) }
        return claudeItems + codexItems
    }

    private func load() async {
        loading = true
        error = nil
        async let fetchedClaude = fetchClaude()
        async let fetchedCodex = fetchCodex()
        let result = await (fetchedClaude, fetchedCodex)
        var problems: [String] = []
        switch result.0 {
        case .success(let accounts):
            claude = accounts
            loaded = true
            SettingsCache.save("claude-accounts", accounts)
        case .failure(let cause):
            problems.append("Anthropic: \(cause.localizedDescription)")
        }
        switch result.1 {
        case .success(let accounts):
            codex = accounts
            loaded = true
            SettingsCache.save("codex-accounts", accounts)
        case .failure(let cause):
            problems.append("OpenAI: \(cause.localizedDescription)")
        }
        error = problems.isEmpty ? nil : problems.joined(separator: "\n")
        loading = false
    }

    private func refreshAccounts() async {
        async let refreshedClaude = fetchClaude(refresh: true)
        async let refreshedCodex = fetchCodex(refresh: true)
        let result = await (refreshedClaude, refreshedCodex)
        var problems: [String] = []
        switch result.0 {
        case .success(let accounts):
            claude = accounts
            SettingsCache.save("claude-accounts", accounts)
        case .failure(let cause):
            problems.append("Anthropic: \(cause.localizedDescription)")
        }
        switch result.1 {
        case .success(let accounts):
            codex = accounts
            SettingsCache.save("codex-accounts", accounts)
        case .failure(let cause):
            problems.append("OpenAI: \(cause.localizedDescription)")
        }
        error = problems.isEmpty ? nil : problems.joined(separator: "\n")
    }

    private func fetchClaude(refresh: Bool = false) async -> Result<[ProviderAccount], Error> {
        do {
            if refresh { return .success(try await SettingsAPI.refreshClaudeAccounts()) }
            return .success(try await SettingsAPI.claudeAccounts())
        } catch { return .failure(error) }
    }

    private func fetchCodex(refresh: Bool = false) async -> Result<[ProviderAccount], Error> {
        do {
            if refresh { return .success(try await SettingsAPI.refreshCodexAccounts()) }
            return .success(try await SettingsAPI.codexAccounts())
        } catch { return .failure(error) }
    }

    private func addAccount(kind: AccountKind, name: String, value: String, owner: String?) async {
        do {
            if kind == .claude {
                let body: [String: Any] = ["name": name, "token": value, "owner": owner ?? NSNull()]
                claude.append(try await SettingsAPI.createClaudeAccount(body))
            } else {
                let body: [String: Any] = ["name": name, "kind": "api_key", "value": value, "owner": owner ?? NSNull()]
                codex.append(try await SettingsAPI.createCodexAccount(body))
            }
            showingAdd = nil
        } catch { self.error = error.localizedDescription }
    }

    private func toggleOwnership(_ account: ProviderAccount, kind: AccountKind) async {
        guard let id = account.id else { return }
        do {
            let owner: String? = account.owner?.isEmpty == false ? nil : ServerConfig.shared.userName
            let patch: [String: Any] = ["owner": owner ?? NSNull()]
            let result: ProviderAccount
            if kind == .claude { result = try await SettingsAPI.updateClaudeAccount(id: id, patch: patch) }
            else { result = try await SettingsAPI.updateCodexAccount(id: id, patch: patch) }
            if kind == .claude, let index = claude.firstIndex(where: { $0.id == id }) { claude[index] = result }
            if kind == .codex, let index = codex.firstIndex(where: { $0.id == id }) { codex[index] = result }
        } catch { self.error = error.localizedDescription }
    }

    private func remove(_ target: AccountRemoval) async {
        do {
            if target.kind == .claude {
                _ = try await SettingsAPI.deleteClaudeAccount(id: target.id)
                claude.removeAll { $0.id == target.id }
            } else {
                _ = try await SettingsAPI.deleteCodexAccount(id: target.id)
                codex.removeAll { $0.id == target.id }
            }
        } catch { self.error = error.localizedDescription }
        removal = nil
    }
}

private struct ProviderAccountItem: Identifiable {
    let account: ProviderAccount
    let kind: AccountKind

    var id: String { "\(kind.id):\(account.id ?? account.name ?? "account")" }
}

/// One account: what it is, how full it is, and the two things you can do
/// about that.
private struct AccountUsageRow: View {
    let account: ProviderAccount
    let kind: AccountKind
    let onToggleOwnership: () -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                BrandTile(name: kind == .claude ? "claude" : "codex", size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.name ?? account.email ?? "Account")
                    Text("\(providerName) · \(ownership)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                if account.usable == false {
                    Text("Unavailable").foregroundStyle(.orange).font(.caption)
                }
                // Borderless, because a plain button inside a List row takes
                // the whole row's tap otherwise and neither control would be
                // reachable.
                Button(account.owner?.isEmpty == false ? "Shared" : "Owner", action: onToggleOwnership)
                    .buttonStyle(.borderless)
                Button(role: .destructive, action: onRemove) {
                    Label(
                        "Remove \(account.name ?? account.email ?? "account")",
                        systemImage: "trash"
                    )
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                #if os(iOS)
                .frame(minWidth: 44, minHeight: 44)
                #endif
            }
            meter
        }
        .padding(.vertical, 2)
    }

    private var providerName: String { kind == .claude ? "Anthropic" : "OpenAI" }

    /// Whose subscription this is. A shared pool account is the default, so it
    /// is the phrase that needs no name beside it.
    private var ownership: String {
        if let owner = account.owner, owner.isEmpty == false { return "Personal · \(owner)" }
        return "Shared pool"
    }

    /// Every limit the account is running against: the rolling windows and any
    /// per-model cap. Which one is full changes what you do about it, and they
    /// free up at different times, so all of them are on the screen.
    private var limits: [LimitWindow] {
        kind == .claude
            ? AccountUsageReading.claudeLimits(account.usage)
            : AccountUsageReading.codexLimits(account.usage)
    }

    @ViewBuilder
    private var meter: some View {
        if let message = usageProblem {
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(AccountUsageReading.liveLimits(limits).enumerated()), id: \.offset) {
                    _, limit in
                    meterRow(limit)
                }
            }
        }
    }

    /// One limit: what it is and when it frees up, how full it is, and the
    /// number. The columns line up down the account so the bars can be read as
    /// a group rather than one at a time.
    private func meterRow(_ limit: LimitWindow) -> some View {
        let reset = AccountUsageReading.formatReset(limit.resetsAt)
        // One Text, so the reset time is part of the label's line and truncates
        // with it rather than pushing the bar off the row.
        let label =
            Text(limit.label)
            + Text(reset.map { " · \($0)" } ?? "").foregroundStyle(.tertiary)
        return HStack(spacing: 8) {
            label
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
            // A neutral fill, not green: an account with headroom is the
            // normal case and should not draw the eye. Only one near its
            // limit does.
            ProgressView(value: AccountUsageReading.fraction(limit.utilization))
                .tint(meterTint(limit.utilization))
                .frame(width: 88)
            Text(AccountUsageReading.percentLabel(limit.utilization) ?? "–")
                .monospacedDigit()
                .frame(width: 40, alignment: .trailing)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    /// Why there is no meter. "Cannot see the usage" and "nothing spent" look
    /// identical without saying so.
    private var usageProblem: String? {
        if let error = account.usage?.error, error.isEmpty == false {
            return account.usage?.errorStatus == 401 ? "Sign in again to read usage." : error
        }
        if account.noUsageScope == true, account.usage == nil {
            return "This token cannot read usage."
        }
        return nil
    }

    private func meterTint(_ utilization: Double?) -> Color {
        if AccountUsageReading.isNearLimit(utilization) { return OS1VisualStyle.red }
        if AccountUsageReading.isWarning(utilization) { return .orange }
        return Color.secondary
    }
}
