import Foundation
import Observation

/// Per-user sidebar lanes — the "claim" half of the sidebar's personal triage.
///
/// An entry claims a SESSION into YOUR sidebar. That is what pulls an
/// automation's run, or a workspace someone else started, into your own list:
/// the value either forces a status lane on the web ("pending", "review", …)
/// or, as "mine", leaves the row to follow its live state. Personal, not
/// workspace state — two teammates can each hold the same workspace.
/// Same store the web sidebar writes (`GET/PUT /api/lanes`, see
/// src/server/lanes.ts and src/frontend/lib/lanes.ts), so a row claimed in the
/// browser is yours on the phone too.
///
/// This app READS the map and never writes it. Claiming is a browser action,
/// and the reason the app needs the map at all is `PeopleLens`: a claim is one
/// of the things that makes a row yours under "My sessions". Without it a
/// claimed workspace showed in the browser and nowhere here.
///
/// Only the KEYS are kept. The values force a status lane, and this app groups
/// its list by activity bands rather than status lanes, so there is nothing
/// here for them to change.
@Observable
@MainActor
final class LaneStore {
    static let shared = LaneStore()

    /// Session ids this user has claimed.
    private(set) var claims: Set<String> = []

    private var hydratedContext: NativePreferences.Context?
    private(set) var hasHydrated = false

    init() {}

    /// Load this user's map from the server. Guarded like `HideStore.hydrate`:
    /// a response for a server/user that has since changed is dropped.
    func hydrate() async {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        guard let loaded = try? await SettingsAPI.lanes(user: requestContext.user) else { return }
        guard NativePreferences.context() == requestContext else { return }
        applyHydrated(loaded)
    }

    private func resetForNewContext(_ context: NativePreferences.Context) {
        guard let hydratedContext else {
            self.hydratedContext = context
            return
        }
        guard hydratedContext != context else { return }
        self.hydratedContext = context
        claims = []
        hasHydrated = false
    }

    /// Kept internal so the claim set can be covered in tests without a server.
    func applyHydrated(_ loaded: [String: String]) {
        hasHydrated = true
        let next = Set(loaded.keys)
        if next != claims { claims = next }
    }
}
