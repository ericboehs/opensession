import Foundation
import Observation

/// GitHub device-flow sign-in against the OpenSession server. The server owns
/// the OAuth app: we start a flow (`/api/auth/device`), show the user code,
/// and poll (`/api/auth/device/poll`, `native: true`) until GitHub confirms —
/// the server then mints its own web-session token and returns it in the body
/// (native clients can't use the HttpOnly cookie). That token goes into the
/// keychain via ServerConfig and rides as `Authorization: Bearer`.
@MainActor
enum GitHubAuth {
    struct DeviceFlowStart: Decodable {
        let deviceCode: String
        let userCode: String
        let verificationUri: String
        let interval: Int?
        let expiresIn: Int?
        let error: String?
    }

    struct PollResponse: Decodable {
        let status: String?
        let login: String?
        let name: String?
        let token: String?
        let interval: Int?
        let error: String?
    }

    enum AuthError: LocalizedError {
        case notConfigured
        case server(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: "Set the server URL first."
            case .server(let message): message
            }
        }
    }

    static func start() async throws -> DeviceFlowStart {
        let flow: DeviceFlowStart = try await post("/api/auth/device", body: [:])
        if let error = flow.error, !error.isEmpty { throw AuthError.server(error) }
        return flow
    }

    /// Polls until sign-in completes, the flow expires, or the task is
    /// cancelled. On success the token + identity are already stored. The
    /// deadline is passed in (not derived from `expiresIn`) so a resumed
    /// flow keeps its original expiry.
    static func waitForAuthorization(_ flow: DeviceFlowStart, until deadline: Date) async throws -> String {
        var interval = TimeInterval(max(flow.interval ?? 5, 1))
        while Date() < deadline {
            try await Task.sleep(for: .seconds(interval))
            let poll: PollResponse
            do {
                poll = try await post(
                    "/api/auth/device/poll",
                    body: ["deviceCode": flow.deviceCode, "native": true]
                )
            } catch is URLError {
                // Entering the code happens outside the app (Safari/GitHub), so
                // a poll is often in flight when iOS suspends us and fails with
                // a network error on resume. That's not a failed sign-in — keep
                // polling until the code expires.
                continue
            }
            switch poll.status {
            case "ok":
                guard let token = poll.token, !token.isEmpty else {
                    throw AuthError.server("Server returned no token — is it up to date?")
                }
                ServerConfig.shared.token = token
                ServerConfig.shared.githubLogin = poll.login ?? ""
                if let name = poll.name, !name.isEmpty {
                    ServerConfig.shared.userName = name
                }
                return poll.login ?? "github"
            case "slow_down":
                interval = TimeInterval(max(poll.interval ?? Int(interval) + 5, Int(interval)))
            case "pending", nil:
                continue
            default:
                throw AuthError.server(poll.error ?? "Sign-in failed.")
            }
        }
        throw AuthError.server("The sign-in code expired — try again.")
    }

    private static func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        guard let base = ServerConfig.shared.baseURL,
              let url = URL(string: base.absoluteString + path)
        else { throw AuthError.notConfigured }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            // The server sends {error} bodies with 400s — surface them.
            if let decoded = try? JSONDecoder().decode(PollResponse.self, from: data),
               let error = decoded.error {
                throw AuthError.server(error)
            }
            throw AuthError.server("Server returned HTTP \(http.statusCode).")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

/// Persisted shape of an in-flight device flow, so the sign-in survives the
/// app being jettisoned while the person is over in Safari entering the code.
private struct PendingDeviceFlow: Codable {
    let deviceCode: String
    let userCode: String
    let verificationUri: String
    let interval: Int
    let expiresAt: Date
}

/// Owns the device-flow sign-in OUTSIDE any view lifecycle. Entering the code
/// happens in Safari/the GitHub app, and iOS is free to suspend or kill us in
/// the meantime — so the code prompt and the polling loop must not live in a
/// sheet's @State. The Settings sheet just renders whatever is in here; the
/// flow itself survives the sheet closing, the app backgrounding, and even a
/// relaunch (the pending flow is persisted until it expires, ~15 min).
@MainActor
@Observable
final class GitHubSignIn {
    static let shared = GitHubSignIn()

    /// The flow whose code the UI should show (nil = no sign-in running).
    private(set) var flow: GitHubAuth.DeviceFlowStart?
    private(set) var starting = false
    var error: String?

    private var pollTask: Task<Void, Never>?
    private static let pendingKey = "os1.pendingDeviceFlow"

    private init() {
        resumePersisted()
    }

    func start() {
        cancel()
        error = nil
        starting = true
        pollTask = Task {
            do {
                let started = try await GitHubAuth.start()
                let deadline = Date().addingTimeInterval(TimeInterval(started.expiresIn ?? 900))
                starting = false
                flow = started
                persist(started, expiresAt: deadline)
                _ = try await GitHubAuth.waitForAuthorization(started, until: deadline)
            } catch is CancellationError {
                return // explicit cancel — state already cleared
            } catch {
                self.error = error.localizedDescription
            }
            starting = false
            finish()
        }
    }

    /// Stop polling and forget the pending flow (explicit user cancel).
    func cancel() {
        pollTask?.cancel()
        pollTask = nil
        starting = false
        finish()
    }

    private func finish() {
        flow = nil
        pollTask = nil
        UserDefaults.standard.removeObject(forKey: Self.pendingKey)
    }

    private func persist(_ flow: GitHubAuth.DeviceFlowStart, expiresAt: Date) {
        let pending = PendingDeviceFlow(
            deviceCode: flow.deviceCode,
            userCode: flow.userCode,
            verificationUri: flow.verificationUri,
            interval: flow.interval ?? 5,
            expiresAt: expiresAt
        )
        if let data = try? JSONEncoder().encode(pending) {
            UserDefaults.standard.set(data, forKey: Self.pendingKey)
        }
    }

    /// Pick an unexpired flow back up after a relaunch mid-sign-in.
    private func resumePersisted() {
        guard let data = UserDefaults.standard.data(forKey: Self.pendingKey),
              let pending = try? JSONDecoder().decode(PendingDeviceFlow.self, from: data),
              pending.expiresAt > Date()
        else {
            UserDefaults.standard.removeObject(forKey: Self.pendingKey)
            return
        }
        let restored = GitHubAuth.DeviceFlowStart(
            deviceCode: pending.deviceCode,
            userCode: pending.userCode,
            verificationUri: pending.verificationUri,
            interval: pending.interval,
            expiresIn: nil,
            error: nil
        )
        flow = restored
        pollTask = Task {
            do {
                _ = try await GitHubAuth.waitForAuthorization(restored, until: pending.expiresAt)
            } catch is CancellationError {
                return
            } catch {
                self.error = error.localizedDescription
            }
            finish()
        }
    }
}
