import Foundation

private final class SafeImageRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        var redirected = request
        if let original = task.originalRequest?.url,
           let target = request.url,
           (original.scheme != target.scheme
            || original.host != target.host
            || original.port != target.port) {
            redirected.setValue(nil, forHTTPHeaderField: "Authorization")
        }
        completionHandler(redirected)
    }
}

/// Thin REST client for the OpenSession HTTP API. Prompting is WS-only on the
/// server, so this covers reads plus the occasional mutation.
@MainActor
enum OS1API {
    private static let imageSession = URLSession(
        configuration: .default,
        delegate: SafeImageRedirectDelegate(),
        delegateQueue: nil
    )

    enum APIError: LocalizedError {
        case notConfigured
        case badURL
        case http(Int)
        case server(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: "Server URL or token not set — open Settings."
            case .badURL: "Invalid server URL."
            case .http(let code):
                code == 401
                    ? "Not signed in (401) — check your token in Settings."
                    : "Server returned HTTP \(code)."
            case .server(let message): message
            }
        }
    }

    static func sessions() async throws -> [Session] {
        try await get("/api/sessions")
    }

    struct WorkspaceSummary: Decodable, Sendable {
        let id: String
        let name: String
    }

    /// Canonical workspace names for collapsing sibling chats into one row.
    static func workspaces() async throws -> [WorkspaceSummary] {
        struct WorkspacesResponse: Decodable, Sendable {
            let projects: [WorkspaceSummary]
        }
        let response: WorkspacesResponse = try await get("/api/projects")
        return response.projects
    }

    static func transcript(sessionId: String) async throws -> [TranscriptEntry] {
        try await get("/api/sessions/\(sessionId)/transcript")
    }

    /// Full content for an entry the WS delivered clamped.
    static func fullEntryContent(sessionId: String, entryId: String) async throws -> String {
        struct EntryResponse: Decodable { let content: String }
        let response: EntryResponse = try await get("/api/sessions/\(sessionId)/entry/\(entryId)")
        return response.content
    }

    /// Resolve an image from a bounded transcript entry. Large inline images
    /// arrive over the wire as `os-blob:<entry>/<index>` and are served as
    /// authenticated bytes by the transcript-image route.
    static func conversationImage(source: String, sessionId: String) async throws -> Data {
        if source.hasPrefix("os-blob:"),
           let slash = source.lastIndex(of: "/"),
           let index = Int(source[source.index(after: slash)...]) {
            let entryId = String(source[source.index(source.startIndex, offsetBy: 8)..<slash])
            return try await getData(
                "/api/sessions/\(sessionId)/transcript-image/\(entryId)/\(index)"
            )
        }

        guard let url = URL(string: source) else { throw APIError.badURL }
        let config = ServerConfig.shared
        let base = config.baseURL
        let sameOrigin = url.scheme == base?.scheme
            && url.host == base?.host
            && url.port == base?.port
        let request = sameOrigin
            ? config.authorizedRequest(url)
            : URLRequest(url: url)
        return try await responseData(for: request)
    }

    /// PR details for the session's branch, or nil when it has no PR — the
    /// route answers a bare JSON `null` in that case (a real answer, not an
    /// error), so probe the raw body before decoding.
    static func pr(sessionId: String) async throws -> PrDetails? {
        let data = try await getData("/api/sessions/\(sessionId)/pr")
        let body = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty || body == "null" { return nil }
        return try await decodeDetached(PrDetails.self, from: data)
    }

    struct GitStatus: Decodable, Sendable, Equatable {
        let branch: String?
        let hasUpstream: Bool
        let ahead: Int
        let behind: Int
        let behindBase: Int
        let baseBranch: String
        let uncommittedFiles: Int
    }

    struct DiffFile: Decodable, Sendable, Identifiable, Equatable {
        let path: String
        let oldPath: String?
        let status: String
        let additions: Int
        let deletions: Int
        let binary: Bool?

        var id: String { path }
    }

    struct SessionDiff: Decodable, Sendable, Equatable {
        let branch: String?
        let baseRef: String?
        let files: [DiffFile]
        let totalAdditions: Int
        let totalDeletions: Int
        let truncated: Bool?
    }

    struct RepoDiff: Decodable, Sendable, Equatable {
        let repo: String
        let dir: String?
        let primary: Bool
        let diff: SessionDiff
    }

    struct SessionDiffResponse: Decodable, Sendable, Equatable {
        let repos: [RepoDiff]
    }

    struct WorkspaceOverview: Decodable, Sendable, Equatable {
        struct Message: Decodable, Sendable, Equatable {
            let content: String
            let sessionId: String
            let at: String
        }

        let prompt: Message?
        let lastMessage: Message?
    }

    static func gitStatus(sessionId: String, repo: String) async throws -> GitStatus? {
        let encodedRepo = repo.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
            ?? repo
        let data = try await getData(
            "/api/sessions/\(sessionId)/git-status?repo=\(encodedRepo)"
        )
        let body = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty || body == "null" { return nil }
        return try await decodeDetached(GitStatus.self, from: data)
    }

    static func sessionDiff(sessionId: String) async throws -> SessionDiffResponse {
        try await get("/api/sessions/\(sessionId)/diff")
    }

    static func workspaceOverview(workspaceId: String) async throws -> WorkspaceOverview {
        try await get("/api/workspaces/\(workspaceId)/overview")
    }

    /// Archive (or unarchive) a session. Archiving an in-flight session also
    /// stops its run server-side.
    static func setArchived(sessionId: String, archived: Bool) async throws {
        struct ArchiveResponse: Decodable { let ok: Bool? }
        let _: ArchiveResponse = try await post(
            "/api/sessions/\(sessionId)/archive",
            body: ["archived": archived]
        )
    }

    static func renameWorkspace(workspaceId: String, name: String) async throws {
        struct RenameResponse: Decodable { let project: WorkspaceSummary? }
        let _: RenameResponse = try await patch(
            "/api/projects/\(workspaceId)",
            body: ["name": name]
        )
    }

    static func renameSession(sessionId: String, title: String) async throws {
        struct RenameResponse: Decodable { let ok: Bool? }
        let _: RenameResponse = try await put(
            "/api/sessions/\(sessionId)/title",
            body: ["title": title]
        )
    }

    struct AuthStatus: Decodable {
        let authenticated: Bool?
        let login: String?
        let name: String?
    }

    /// Signed-in identity for the current bearer token. Used to backfill
    /// `githubLogin` on devices whose token predates the app storing the
    /// login at sign-in time (the avatar needs it).
    static func authStatus() async throws -> AuthStatus {
        try await get("/api/auth/status")
    }

    /// Revoke the server-side web session before removing its keychain copy.
    static func logout() async throws {
        struct LogoutResponse: Decodable { let ok: Bool? }
        let _: LogoutResponse = try await post("/api/auth/logout", body: [:])
    }

    /// Unauthenticated liveness probe; also carries the server bootId.
    static func health() async throws -> Bool {
        struct Health: Decodable { let ok: Bool? }
        let health: Health = try await get("/api/health", authorized: false)
        return health.ok ?? true
    }

    // MARK: - Session creation

    private struct ServerErrorBody: Decodable { let error: String? }

    struct RepoInfo: Decodable, Identifiable, Hashable {
        let id: String
        let ghRepo: String?
        let label: String?
        let defaultBranch: String?
        let sharedCheckout: Bool?
        let isDefault: Bool?

        private enum CodingKeys: String, CodingKey {
            case id, ghRepo, label, defaultBranch, sharedCheckout
            case isDefault = "default"
        }
    }

    /// Repos a new session can target.
    static func repos() async throws -> [RepoInfo] {
        struct ReposResponse: Decodable { let repos: [RepoInfo] }
        let response: ReposResponse = try await get("/api/repos")
        return response.repos
    }

    /// Models (and presets) a session can run on, plus the interactive default.
    static func models() async throws -> ModelCatalog {
        try await get("/api/models")
    }

    /// Create a session; returns the new session id. Code mode gets a
    /// server-suggested branch; the opening run starts immediately.
    static func createSession(
        prompt: String,
        repo: String,
        mode: String,
        model: String? = nil,
        effort: String? = nil,
        fastMode: Bool = false,
        images: [String] = []
    ) async throws -> String {
        struct CreateResponse: Decodable { let id: String }
        var body: [String: Any] = ["prompt": prompt, "mode": mode]
        if !repo.isEmpty { body["repo"] = repo }
        if let model, !model.isEmpty { body["model"] = model }
        if let effort, !effort.isEmpty { body["effort"] = effort }
        if fastMode { body["fastMode"] = true }
        if !images.isEmpty { body["images"] = images }
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        let response: CreateResponse = try await post("/api/sessions", body: body)
        return response.id
    }

    private static func post<T: Decodable & Sendable>(
        _ path: String,
        body: [String: Any]
    ) async throws -> T {
        try await mutate(path, method: "POST", body: body)
    }

    private static func put<T: Decodable & Sendable>(
        _ path: String,
        body: [String: Any]
    ) async throws -> T {
        try await mutate(path, method: "PUT", body: body)
    }

    private static func patch<T: Decodable & Sendable>(
        _ path: String,
        body: [String: Any]
    ) async throws -> T {
        try await mutate(path, method: "PATCH", body: body)
    }

    private static func mutate<T: Decodable & Sendable>(
        _ path: String,
        method: String,
        body: [String: Any]
    ) async throws -> T {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard config.isConfigured else { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }

        var request = config.authorizedRequest(url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            if let serverError = try? JSONDecoder().decode(ServerErrorBody.self, from: data),
               let message = serverError.error {
                throw APIError.server(message)
            }
            throw APIError.http(http.statusCode)
        }
        return try await decodeDetached(T.self, from: data)
    }

    private static func get<T: Decodable & Sendable>(
        _ path: String,
        authorized: Bool = true
    ) async throws -> T {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        if authorized && !config.isConfigured { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }

        let request = authorized ? config.authorizedRequest(url) : URLRequest(url: url)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.http(http.statusCode)
        }
        return try await decodeDetached(T.self, from: data)
    }

    /// Decode off the main actor. OS1API is @MainActor, and decoding inline
    /// parked multi-megabyte payloads on the main thread — `/api/sessions`
    /// alone is ~4MB / thousands of rows every 5s poll, a visible periodic
    /// hitch while typing (long transcripts weren't small either).
    private static func decodeDetached<T: Decodable & Sendable>(
        _ type: T.Type,
        from data: Data
    ) async throws -> T {
        try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(T.self, from: data)
        }.value
    }

    private static func getData(_ path: String) async throws -> Data {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard config.isConfigured else { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }
        return try await responseData(for: config.authorizedRequest(url))
    }

    private static func responseData(for request: URLRequest) async throws -> Data {
        let (data, response) = try await imageSession.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.http(http.statusCode)
        }
        return data
    }
}
