import SwiftUI

/// Settings → Sandboxes: where a session's code actually runs.
///
/// The web page (src/frontend/components/settings/SandboxesPanel.tsx) is also
/// where connections are created, credentials entered and environments rebuilt.
/// None of that is phone work: it is credential entry and long-running builds.
/// What IS phone work is the half a person reads and the one thing they set —
/// which sandbox their own new sessions start in — so that is this screen, and
/// the footer says where the rest lives.
struct SandboxesSettingsView: View {
    @State private var status: SandboxSettingsStatus? = SettingsCache.value("sandbox-status")
    /// "workspace" is the server's own word for "no personal override",
    /// and the value it answers with when none is set. Seeding the empty
    /// string instead matched no option and drew a blank picker.
    @State private var personal = "workspace"
    @State private var loading = true
    @State private var error: String?

    private var user: String { ServerConfig.shared.userName }

    var body: some View {
        List {
            if loading, status == nil { settingsLoadingRow }
            if let error { settingsErrorRow(error) { Task { await load() } } }

            if let status {
                if status.enabled == false || status.killSwitch == true {
                    Section {
                        Text(status.killSwitch == true
                            ? "Sandboxes are switched off for this instance. New sessions run on the host."
                            : "This instance does not offer sandboxes. New sessions run on the host.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        // Same options the web offers (SandboxDefaults.tsx):
                        // deferring to the workspace, the host, or a provider
                        // that is actually ready. "None" is the server's own
                        // word for the host, and it is a real choice rather
                        // than an absence.
                        Picker("Your new sessions", selection: $personal) {
                            Text("Workspace default · \(workspaceLabel(status))").tag("workspace")
                            Text("None").tag("none")
                            ForEach(status.readyProviders, id: \.self) { provider in
                                Text(SandboxSettingsStatus.defaultLabel(provider)).tag(provider)
                            }
                            // A default set before a provider stopped being
                            // ready still has to be selectable, or the picker
                            // renders blank and reads as broken.
                            if let orphan = orphanSelection(status) {
                                Text("\(SandboxSettingsStatus.defaultLabel(orphan)) · unavailable")
                                    .tag(orphan)
                            }
                        }
                    } header: {
                        Text("Default")
                    } footer: {
                        Text(defaultsFooter(status))
                    }

                    Section {
                        let connections = (status.connections ?? []).filter { $0.id?.isEmpty == false }
                        if connections.isEmpty {
                            Text("No sandbox connections. New sessions run on the host.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(connections, id: \.id) { connection in
                            SandboxConnectionRow(connection: connection)
                        }
                    } header: {
                        Text("Connections")
                    } footer: {
                        Text("Only a ready connection can run a session. Add one, enter its credentials or repair it on the web.")
                    }

                    // Providers this build knows how to talk to, whether or not
                    // anyone has wired one up. Read-only: it answers "could we
                    // use Modal" rather than "is Modal working".
                    let providers = (status.providers ?? []).filter { $0.id?.isEmpty == false }
                    if providers.isEmpty == false {
                        Section("Providers") {
                            ForEach(providers, id: \.id) { provider in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(SandboxOffering.label(provider.id ?? ""))
                                        if let note = provider.note, note.isEmpty == false {
                                            Text(note).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer(minLength: 12)
                                    Text(providerState(provider))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .insetGroupedListCompat()
        .navigationTitle("Sandboxes")
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: personal) { previous, value in
            // The first assignment is the fetch seeding the control, not a
            // person choosing — saving it would write the server's own answer
            // back at it on every visit.
            guard loading == false, previous != value else { return }
            Task { await savePersonal(value) }
        }
    }

    private func workspaceLabel(_ status: SandboxSettingsStatus) -> String {
        SandboxSettingsStatus.defaultLabel(
            status.defaults?.workspace ?? status.defaultProvider ?? "none"
        )
    }

    /// A personal default naming a provider that is no longer on offer. It has
    /// to stay in the picker or the control renders with nothing selected.
    private func orphanSelection(_ status: SandboxSettingsStatus) -> String? {
        let value = status.defaults?.personal ?? ""
        guard value.isEmpty == false, value != "workspace", value != "none" else { return nil }
        return status.readyProviders.contains(value) ? nil : value
    }

    private func defaultsFooter(_ status: SandboxSettingsStatus) -> String {
        let effective = SandboxSettingsStatus.defaultLabel(status.defaults?.effective ?? "none")
        return effective == "None"
            ? "None keeps your sessions on this host. A per-session choice still overrides this."
            : "New sessions of yours start in \(effective). A per-session choice still overrides this."
    }

    private func providerState(_ provider: SandboxSettingsStatus.Provider) -> String {
        if provider.configured != true { return "Not configured" }
        return provider.certified == true ? "Certified" : "Not certified"
    }

    private func load() async {
        loading = true; error = nil
        do {
            let fetched = try await SettingsAPI.sandboxStatus(user: user)
            status = fetched
            personal = fetched.defaults?.personal ?? "workspace"
            SettingsCache.save("sandbox-status", fetched)
        } catch { self.error = error.localizedDescription }
        loading = false
    }

    private func savePersonal(_ value: String) async {
        do {
            let result = try await SettingsAPI.setSandboxDefault(
                scope: "personal",
                value: value,
                user: user
            )
            if var current = status {
                current.defaults = result.defaults
                status = current
                SettingsCache.save("sandbox-status", current)
            }
        } catch { self.error = error.localizedDescription }
    }
}

/// One sandbox connection: which provider it is, whether it can run a session,
/// and what is stopping it if it cannot.
private struct SandboxConnectionRow: View {
    let connection: SandboxSettingsStatus.Connection

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(SandboxOffering.label(connection.provider ?? ""))
                if connection.summary.isEmpty == false {
                    Text(connection.summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 12)
            Text(connection.stateLabel)
                .font(.caption)
                .foregroundStyle(connection.isReady ? Color.secondary : OS1VisualStyle.red)
        }
        .padding(.vertical, 2)
    }
}
