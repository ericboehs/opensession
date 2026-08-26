import Foundation

/// A service the session exposes on a port: its dev server, a docs site, a
/// dashboard it brought up. The web calls the surface Portals; the wire calls
/// it preview status, and `GET /api/sessions/:id/preview` answers the same
/// shape for a host worktree, a sandbox, and a Runner.
///
/// Decoded tolerantly, like every other model here: the server adds fields,
/// and an older build must keep rendering the rows it does understand.
/// `state` in particular arrives absent from servers that predate it, and can
/// gain values this build has never heard of.
struct PortalService: Decodable, Sendable, Hashable, Identifiable {
    /// What the repository calls it, or a friendly name derived from the key.
    let name: String
    /// The `.ports.conf` key. Stable, so it is the row's identity.
    let key: String
    let port: Int
    let running: Bool
    /// The authenticated HTTPS URL, present only while something is listening.
    let previewUrl: String?
    let description: String?
    /// Where in the app to land instead of its root.
    let defaultPath: String?
    let state: PortalState?
    /// Whether the supervisor owns this service's lifecycle. Only a managed
    /// portal can be stopped or restarted; anything else is a process the
    /// session started for itself, which this app has no handle on.
    let managed: Bool

    var id: String { key }

    private enum CodingKeys: String, CodingKey {
        case name, key, port, running, previewUrl, description, defaultPath, state, managed
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        name = (try? container.decode(String.self, forKey: .name)) ?? key
        port = (try? container.decode(Int.self, forKey: .port)) ?? 0
        running = (try? container.decode(Bool.self, forKey: .running)) ?? false
        previewUrl = (try? container.decodeIfPresent(String.self, forKey: .previewUrl)) ?? nil
        description = (try? container.decodeIfPresent(String.self, forKey: .description)) ?? nil
        defaultPath = (try? container.decodeIfPresent(String.self, forKey: .defaultPath)) ?? nil
        state = (try? container.decodeIfPresent(PortalState.self, forKey: .state)) ?? nil
        managed = ((try? container.decodeIfPresent(Bool.self, forKey: .managed)) ?? nil) ?? false
    }

    /// For tests and previews.
    init(
        name: String,
        key: String,
        port: Int,
        running: Bool,
        previewUrl: String? = nil,
        description: String? = nil,
        defaultPath: String? = nil,
        state: PortalState? = nil,
        managed: Bool = false
    ) {
        self.name = name
        self.key = key
        self.port = port
        self.running = running
        self.previewUrl = previewUrl
        self.description = description
        self.defaultPath = defaultPath
        self.state = state
        self.managed = managed
    }

    /// What tapping the row opens, or nil when there is nothing live behind
    /// it. A sleeping sandbox deliberately reports no URL: the server drops it
    /// from the sleeping view so that reading the list can never wake compute,
    /// and this app never asks it to.
    var openURL: URL? {
        guard running, let previewUrl, let base = URL(string: previewUrl) else { return nil }
        guard let defaultPath, !defaultPath.isEmpty else { return base }
        let path = defaultPath.hasPrefix("/") ? defaultPath : "/" + defaultPath
        return URL(string: path, relativeTo: base)?.absoluteURL ?? base
    }

    /// The one word the row shows for where this service is right now.
    var display: PortalDisplayState {
        // Openable beats everything else: whatever the lifecycle says, a
        // service answering on a URL is one you can look at.
        if openURL != nil { return .live }
        switch state {
        case .sleeping: return .sleeping
        case .waking: return .waking
        case .starting: return .starting
        case .failed: return .failed
        case .awake, .stopped, .unknown, .none: return running ? .unavailable : .stopped
        }
    }

    /// Stopping only means something while the service is up, and the server
    /// refuses it on a sleeping Sandbox rather than waking one to kill a
    /// process — so the row never offers it there.
    var canStop: Bool { managed && running }

    /// Restarting is the action a phone is for: the dev server died, bring it
    /// back. Offered on every managed row, including a sleeping one, where it
    /// is the way to get the service back.
    var canRestart: Bool { managed }

    /// Whether to ask first. Stopping takes a service away from whoever is
    /// looking at it, and restarting a sleeping portal wakes the Sandbox it
    /// lives in and bills the compute. Restarting one that is already up is
    /// the one-tap fix this screen exists for, so it just runs.
    func needsConfirmation(for action: PortalAction) -> Bool {
        action == .stop || display == .sleeping
    }
}

/// What a managed portal can be told to do. Reading the list never wakes a
/// Sandbox; a restart deliberately may, because a person asked for it.
enum PortalAction: String, Sendable, Hashable {
    case stop
    case restart

    var buttonLabel: String {
        switch self {
        case .stop: "Stop"
        case .restart: "Restart"
        }
    }

    /// What the row says while the server is working on it.
    var progressLabel: String {
        switch self {
        case .stop: "Stopping…"
        case .restart: "Restarting…"
        }
    }

    /// The alert's title when it fails, so the message underneath can be the
    /// server's own words.
    var failureTitle: String {
        switch self {
        case .stop: "Couldn't stop the portal"
        case .restart: "Couldn't restart the portal"
        }
    }
}

/// A starter the repository declares in `.agents/portals.json`: a skill this
/// session's agent can run to bring a service up.
///
/// The app never runs anything itself. It asks the agent, in the session, with
/// the same words the web sends, so a person reading the conversation later
/// sees one instruction rather than two dialects of it.
struct PortalRecipe: Decodable, Sendable, Hashable, Identifiable {
    let name: String
    let description: String?
    /// The user-invocable skill that starts it.
    let skill: String
    /// The `.ports.conf` key expected to be live once the skill has run.
    let serviceKey: String?

    var id: String { "\(skill):\(serviceKey ?? name)" }

    private enum CodingKeys: String, CodingKey { case name, description, skill, serviceKey }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        skill = try container.decode(String.self, forKey: .skill)
        description = (try? container.decodeIfPresent(String.self, forKey: .description)) ?? nil
        serviceKey = (try? container.decodeIfPresent(String.self, forKey: .serviceKey)) ?? nil
    }

    init(name: String, description: String? = nil, skill: String, serviceKey: String? = nil) {
        self.name = name
        self.description = description
        self.skill = skill
        self.serviceKey = serviceKey
    }

    /// What the row shows under the name when the repository said nothing.
    var subtitle: String { description ?? "Starts with the \(skill) skill." }

    /// The message sent to the session. Kept word for word in step with the
    /// web's `onStartPortal`, because both end up in the same transcript.
    var startPrompt: String {
        let opening = "Use the $\(skill) skill to start the “\(name)” portal for this session. "
        guard let serviceKey, !serviceKey.isEmpty else {
            return opening
                + "Expose its listening port in .ports.conf with a descriptive "
                + "*_PORT key, then report when it is ready."
        }
        return opening
            + "Make sure it listens on the \(serviceKey) port declared in "
            + ".ports.conf, then report when it is ready."
    }
}

/// The supervisor's lifecycle for a managed portal. An unknown value decodes
/// rather than throws, so a server that grows a state does not blank the list.
enum PortalState: String, Decodable, Sendable {
    case starting
    case awake
    case sleeping
    case waking
    case failed
    case stopped
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PortalState(rawValue: raw) ?? .unknown
    }
}

/// What a row says, kept apart from how it draws so the mapping can be tested
/// without a view.
enum PortalDisplayState: Sendable, Hashable {
    /// Listening, with a URL to open.
    case live
    case starting
    case waking
    /// The sandbox is asleep. Its portals come back when it wakes, and nothing
    /// on this screen wakes it.
    case sleeping
    case failed
    case stopped
    /// Listening, but with nothing this app can open: a Runner portal whose
    /// authenticated route was never registered, for instance.
    case unavailable

    var label: String {
        switch self {
        case .live: "Live"
        case .starting: "Starting"
        case .waking: "Waking"
        case .sleeping: "Sleeping"
        case .failed: "Failed"
        case .stopped: "Stopped"
        case .unavailable: "Unavailable"
        }
    }
}

/// `GET /api/sessions/:id/preview`, of which this app reads the services and
/// the starters.
///
/// The full supervised-control panel stays on the desktop. What a phone keeps
/// is the pair of actions you want when you are away from one: look at a
/// service that is up, and get one that isn't back.
struct PortalStatus: Decodable, Sendable {
    let services: [PortalService]
    /// The dev server is being brought up and its ports are not listening yet.
    let starting: Bool
    /// Skill-backed starters from `.agents/portals.json`. A sleeping Sandbox
    /// answers with none, which is why nothing on this screen can offer to
    /// start one and wake it by the back door.
    let recipes: [PortalRecipe]

    private enum CodingKeys: String, CodingKey {
        case services, starting
        case recipes = "portalRecipes"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        services = ((try? container.decodeIfPresent([PortalService].self, forKey: .services)) ?? nil) ?? []
        starting = (try? container.decode(Bool.self, forKey: .starting)) ?? false
        recipes = ((try? container.decodeIfPresent([PortalRecipe].self, forKey: .recipes)) ?? nil) ?? []
    }

    init(services: [PortalService], starting: Bool = false, recipes: [PortalRecipe] = []) {
        self.services = services
        self.starting = starting
        self.recipes = recipes
    }

    /// What the web panel counts in its heading.
    var liveCount: Int { services.filter { $0.openURL != nil }.count }

    /// The starters worth offering: the ones whose service is not already
    /// live. A live one is a row in the list you can tap, and offering to
    /// start it again would be two ways to say the same thing.
    var startableRecipes: [PortalRecipe] {
        recipes.filter { recipe in
            guard let key = recipe.serviceKey, !key.isEmpty else { return true }
            return services.first { $0.key == key }?.openURL == nil
        }
    }
}
