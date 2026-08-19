import Foundation
import Observation

/// Server endpoint + credentials. The URL lives in UserDefaults, the bearer
/// token in the keychain. `ws` path and `Authorization` header conventions
/// follow the Open Session server (see README for the wire protocol).
// Deliberately not actor-isolated: views read `shared` from nonisolated
// property initializers, and the backing stores (UserDefaults/Keychain) are
// safe to touch from any thread.
@Observable
final class ServerConfig {
    static let shared = ServerConfig()

    private static let urlDefaultsKey = "os1.serverURL"
    private static let userNameDefaultsKey = "os1.userName"
    private static let githubLoginDefaultsKey = "os1.githubLogin"
    private static let tokenKeychainKey = "os1.token"

    /// What `userName` holds before anything has set it — a stand-in, not a
    /// name, so surfaces that PRESENT the name (rather than send it) can tell
    /// the two apart and fall back to the GitHub login.
    static let placeholderUserName = "ios"

    var baseURLString: String {
        didSet { UserDefaults.standard.set(baseURLString, forKey: Self.urlDefaultsKey) }
    }

    /// Display name attached to prompts. When GitHub sign-in is active the
    /// server overrides this with the verified identity; it still matters for
    /// servers running without the auth gate.
    var userName: String {
        didSet { UserDefaults.standard.set(userName, forKey: Self.userNameDefaultsKey) }
    }

    /// GitHub login the current token was minted for — empty when the token
    /// was pasted manually. Persisted so Settings can show the signed-in
    /// state across launches.
    var githubLogin: String {
        didSet { UserDefaults.standard.set(githubLogin, forKey: Self.githubLoginDefaultsKey) }
    }

    var token: String {
        didSet {
            if token.isEmpty {
                Keychain.delete(Self.tokenKeychainKey)
                githubLogin = ""
            } else {
                Keychain.set(token, for: Self.tokenKeychainKey)
            }
        }
    }

    private init() {
        // OS1_SERVER / OS1_TOKEN env overrides exist for dev runs on the
        // simulator (SIMCTL_CHILD_* injection); they are not persisted.
        let env = ProcessInfo.processInfo.environment
        let bundledDefault =
            Bundle.main.object(forInfoDictionaryKey: "OS1DefaultServerURL") as? String
        baseURLString = env["OS1_SERVER"]
            ?? UserDefaults.standard.string(forKey: Self.urlDefaultsKey)
            ?? bundledDefault
            ?? "http://127.0.0.1:3850"
        userName = UserDefaults.standard.string(forKey: Self.userNameDefaultsKey)
            ?? Self.placeholderUserName
        githubLogin = UserDefaults.standard.string(forKey: Self.githubLoginDefaultsKey) ?? ""
        token = env["OS1_TOKEN"] ?? Keychain.get(Self.tokenKeychainKey) ?? ""
    }

    /// Base URL without a trailing slash, e.g. `https://sessions.example.com`.
    var baseURL: URL? {
        var trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard !trimmed.isEmpty else { return nil }
        if !trimmed.contains("://") { trimmed = "https://" + trimmed }
        return URL(string: trimmed)
    }

    /// The UI WebSocket endpoint: same host, `/ws`, ws(s) scheme.
    var wsURL: URL? {
        guard let baseURL,
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        else { return nil }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path = "/ws"
        return components.url
    }

    var isConfigured: Bool {
        baseURL != nil && !token.trimmingCharacters(in: .whitespaces).isEmpty
    }

    func authorizedRequest(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    /// Whether `url` is on OUR server, and may therefore carry the token.
    ///
    /// Everything the app fetches by PATH is ours by construction, so this is
    /// only asked where a URL could be either: an avatar is our `/media` when
    /// the person uploaded one and github.com when they did not. Getting it
    /// wrong sends our bearer token to a third party, so it compares scheme,
    /// host and port rather than a string prefix.
    func isOwnURL(_ url: URL) -> Bool {
        guard let base = baseURL,
              let ours = URLComponents(url: base, resolvingAgainstBaseURL: false),
              let theirs = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let ourHost = ours.host?.lowercased(),
              let theirHost = theirs.host?.lowercased()
        else { return false }
        return ours.scheme?.lowercased() == theirs.scheme?.lowercased()
            && ourHost == theirHost
            && ours.port == theirs.port
    }
}
