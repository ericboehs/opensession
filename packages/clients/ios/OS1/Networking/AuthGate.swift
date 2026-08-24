import Foundation
import Observation

/// Whether this device's session is still accepted, and if not, why.
///
/// A session token is not an independent credential: it is a cache of one
/// GitHub authorize, and the server refuses it the moment GitHub permanently
/// rejects the grant behind it (`githubReconnectRequired`, src/server/
/// github-auth.ts). Before this the app simply kept polling into 401s: empty
/// lists, a transcript that never arrived, and nothing saying the fix was a
/// sign-in buried three taps into Settings.
///
/// A single 401 is never trusted on its own. Any route could answer one for a
/// reason of its own, so a refusal is CONFIRMED against `/api/auth/status`,
/// which is exempt from the gate and therefore still answers to a session the
/// gate is refusing. That is also what tells the two cases apart: a grant that
/// died under a session that is otherwise fine, and a session that is simply
/// gone.
@MainActor
@Observable
final class AuthGate {
    static let shared = AuthGate()

    enum Reason: Equatable {
        /// GitHub ended the authorization this session stands on.
        case reconnect(login: String?)
        /// The session itself is gone, expired or signed out elsewhere.
        case signedOut
    }

    /// Non-nil while the server is refusing us, which is what puts the
    /// reconnect cover on screen.
    private(set) var blocked: Reason?

    private var checking = false

    private init() {}

    /// A request came back 401. Cheap and idempotent: callers fire it from
    /// every error tail without caring whether one is already in flight.
    func noteUnauthorized() {
        confirm()
    }

    /// Ask the one route that is never gated whether we are actually out.
    /// A server that predates `required` (or any error at all) leaves the
    /// cover alone: being unsure must never lock someone out of their app.
    func confirm() {
        guard !checking, ServerConfig.shared.isConfigured else { return }
        checking = true
        Task {
            let status = try? await OS1API.authStatus()
            checking = false
            guard let status, status.required == true else {
                blocked = nil
                return
            }
            if status.authenticated == true {
                blocked = nil
                return
            }
            blocked = status.reconnectRequired == true
                ? .reconnect(login: status.login)
                : .signedOut
        }
    }

    /// A sign-in landed and stored a fresh token (GitHubAuth), or the person
    /// pasted one by hand.
    func cleared() {
        blocked = nil
    }
}
