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
    }
}
