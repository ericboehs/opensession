import SwiftUI

/// Settings → Usage: the subscription accounts runs draw from, and how close
/// each one is to its limit.
///
/// Its own page rather than a section of Models, matching the web
/// (src/frontend/components/settings/UsagePanel.tsx): the two are read on
/// different clocks. These meters move hourly and answer "have we got
/// headroom", while a default model is set once and left alone.
///
/// The list and the meters live together because the answer to "this one is
/// spent" is an action on the row: hand it an owner, sign it in again, or take
/// it out of the pool.
struct UsageSettingsView: View {
    @State private var reload = 0

    var body: some View {
        List {
            ProviderAccountSections(reload: reload)
        }
        .insetGroupedListCompat()
        .navigationTitle("Usage")
        .refreshable { reload += 1 }
    }
}

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

    /// Seeded from the last answer this device saw, so re-entering Usage shows
    /// the pools straight away and the fetch behind it only corrects them.
    init(reload: Int) {
        self.reload = reload
        let cachedClaude: [ProviderAccount] = SettingsCache.value("claude-accounts") ?? []
        let cachedCodex: [ProviderAccount] = SettingsCache.value("codex-accounts") ?? []
        _claude = State(initialValue: cachedClaude)
        _codex = State(initialValue: cachedCodex)
        _loaded = State(initialValue: cachedClaude.isEmpty == false || cachedCodex.isEmpty == false)
    }

    var body: some View {
        Group {
            // The `task` hangs off a section rendered in every state. A
            // `Group`'s modifiers apply to each child individually, so parking
            // it on a conditional row would tear the fetch down the moment that
            // row swapped out and leave `loading` stuck true forever.
            accountSection("Claude", accounts: validClaude, kind: .claude)
                .task(id: reload) { await load() }
            accountSection("Codex", accounts: validCodex, kind: .codex)
        }
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

    @ViewBuilder
    private func accountSection(_ title: String, accounts: [ProviderAccount], kind: AccountKind) -> some View {
        Section(title) {
            if loading, loaded == false {
                settingsLoadingRow
            } else if let error, loaded == false {
                settingsErrorRow(error) { Task { await load() } }
            } else {
                if let error, kind == .claude { settingsErrorRow(error) { Task { await load() } } }
                if accounts.isEmpty {
                    Text("No \(title) accounts configured.").foregroundStyle(.secondary)
                }
                ForEach(accounts, id: \.id) { account in
                    AccountUsageRow(
                        account: account,
                        kind: kind,
                        onToggleOwnership: { Task { await toggleOwnership(account, kind: kind) } },
                        onRemove: {
                            removal = AccountRemoval(
                                id: account.id ?? "",
                                name: account.name ?? "this account",
                                kind: kind
                            )
                        }
                    )
                }
                Button { showingAdd = kind } label: { Label("Add \(title) account", systemImage: "plus") }
                if kind == .claude {
                    Button("Refresh account usage") { Task { await refreshClaude() } }
                } else {
                    Button { codexLoginSheet = true } label: {
                        Label("Sign in with ChatGPT", systemImage: "person.badge.key")
                    }
                }
            }
        }
    }

    private func load() async {
        loading = true; error = nil
        do {
            async let fetchedClaude = SettingsAPI.claudeAccounts()
            async let fetchedCodex = SettingsAPI.codexAccounts()
            let result = try await (fetchedClaude, fetchedCodex)
            claude = result.0; codex = result.1
            loaded = true
            SettingsCache.save("claude-accounts", result.0)
            SettingsCache.save("codex-accounts", result.1)
        } catch { self.error = error.localizedDescription }
        loading = false
    }

    private func refreshClaude() async {
        do {
            claude = try await SettingsAPI.refreshClaudeAccounts()
            SettingsCache.save("claude-accounts", claude)
        } catch { self.error = error.localizedDescription }
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

/// One account: what it is, how full it is, and the two things you can do
/// about that.
private struct AccountUsageRow: View {
    let account: ProviderAccount
    let kind: AccountKind
    let onToggleOwnership: () -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.name ?? account.email ?? "Account")
                    Text(ownership)
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
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
            }
            meter
        }
        .padding(.vertical, 2)
    }

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
