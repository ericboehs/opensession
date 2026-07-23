import Foundation

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
    /// cancelled. On success the token + identity are already stored.
    static func waitForAuthorization(_ flow: DeviceFlowStart) async throws -> String {
        var interval = TimeInterval(max(flow.interval ?? 5, 1))
        let deadline = Date().addingTimeInterval(TimeInterval(flow.expiresIn ?? 900))
        while Date() < deadline {
            try await Task.sleep(for: .seconds(interval))
            let poll: PollResponse = try await post(
                "/api/auth/device/poll",
                body: ["deviceCode": flow.deviceCode, "native": true]
            )
            switch poll.status {
            case "ok":
                guard let token = poll.token, !token.isEmpty else {
                    throw AuthError.server("Server returned no token — is it up to date?")
                }
                ServerConfig.shared.token = token
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
