import SwiftUI

/// Settings → Deploys: the internal web apps agents published from sessions.
///
/// They keep running after the session that built them ends, which is the whole
/// point and also the reason this page exists: it is where a person sees what
/// is still up and turns it off. A deploy is agent-authored code running
/// unsandboxed for as long as it is started, so the destructive controls are
/// the ones that matter here, not the reading.
struct DeploysSettingsView: View {
    @State private var deploys: [DeployApp]? = SettingsCache.value("deploys")
    @State private var loading = true
    @State private var error: String?
    @State private var deleting: DeployApp?

    var body: some View {
        List {
            if loading, deploys == nil { settingsLoadingRow }
            if let error { settingsErrorRow(error) { Task { await load() } } }

            if let deploys {
                if deploys.isEmpty {
                    Section {
                        Text("Nothing published yet. Ask a session to build a small internal tool and publish it.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        ForEach(deploys.filter { $0.name?.isEmpty == false }, id: \.id) { deploy in
                            DeployRow(
                                deploy: deploy,
                                onToggleRunning: { Task { await setRunning(deploy, running: !deploy.isRunning) } },
                                onRollBack: { Task { await rollBack(deploy) } },
                                onDelete: { deleting = deploy }
                            )
                        }
                    } footer: {
                        Text("Served at /d/<name>/ behind the same sign-in as \(AppBrand.productName). Only $DATA_DIR survives a redeploy.")
                    }
                }
            }
        }
        .insetGroupedListCompat()
        .navigationTitle("Deploys")
        .task { await load() }
        .refreshable { await load() }
        .alert(
            "Delete this deploy?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            presenting: deleting
        ) { deploy in
            Button("Delete", role: .destructive) { Task { await delete(deploy) } }
            Button("Cancel", role: .cancel) {}
        } message: { deploy in
            Text("\(deploy.name ?? "This app") stops serving and every version of it is removed.")
        }
    }

    private func load() async {
        loading = true; error = nil
        do {
            let fetched = try await SettingsAPI.deploys().deploys ?? []
            deploys = fetched
            SettingsCache.save("deploys", fetched)
        } catch { self.error = error.localizedDescription }
        loading = false
    }

    private func setRunning(_ deploy: DeployApp, running: Bool) async {
        guard let name = deploy.name else { return }
        do {
            _ = try await SettingsAPI.setDeployRunning(name: name, running: running)
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func rollBack(_ deploy: DeployApp) async {
        guard let name = deploy.name, let current = deploy.currentVersion, current > 1 else { return }
        do {
            _ = try await SettingsAPI.rollbackDeploy(name: name, version: current - 1)
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func delete(_ deploy: DeployApp) async {
        guard let name = deploy.name else { return }
        do {
            _ = try await SettingsAPI.deleteDeploy(name: name)
            await load()
        } catch { self.error = error.localizedDescription }
        deleting = nil
    }
}

private struct DeployRow: View {
    let deploy: DeployApp
    let onToggleRunning: () -> Void
    let onRollBack: () -> Void
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(deploy.name ?? "App")
                Spacer(minLength: 12)
                Text(stateLabel)
                    .font(.caption)
                    .foregroundStyle(stateTint)
            }
            if deploy.summary.isEmpty == false {
                Text(deploy.summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 16) {
                // Borderless: a plain button in a List row swallows the whole
                // row's tap, and this row has three.
                Button(deploy.isRunning ? "Stop" : "Start", action: onToggleRunning)
                    .buttonStyle(.borderless)
                if deploy.canRollBack {
                    Button("Roll back", action: onRollBack)
                        .buttonStyle(.borderless)
                }
                Button("Delete", role: .destructive, action: onDelete)
                    .buttonStyle(.borderless)
            }
            .font(.subheadline)
        }
        .padding(.vertical, 2)
    }

    private var stateLabel: String {
        switch deploy.state {
        case "running": "Running"
        case "stopped": "Stopped"
        case "crashed": "Crashed"
        case let other?: other
        case nil: "Unknown"
        }
    }

    private var stateTint: Color {
        switch deploy.state {
        case "crashed": OS1VisualStyle.red
        case "running": Color.secondary
        default: Color.secondary
        }
    }
}
