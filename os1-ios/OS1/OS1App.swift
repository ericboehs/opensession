import SwiftUI

@main
struct OS1App: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var config = ServerConfig.shared
    @State private var showedInitialSettings = false
    @State private var showSettings = false

    var body: some View {
        SessionsListView()
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
            .onAppear {
                if !config.isConfigured && !showedInitialSettings {
                    showedInitialSettings = true
                    showSettings = true
                }
            }
            // Coming back from Safari/GitHub after approving the device code:
            // poll right away so the sign-in lands the moment we're foreground
            // (also revives a poll loop that died with the process).
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { GitHubSignIn.shared.nudge() }
            }
    }
}
