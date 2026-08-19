import Foundation

/// One row from `GET /api/models` — a pickable model or preset. Tolerant
/// decoding (everything but `id` optional) so server additions never break us.
struct ModelOption: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    var label: String?
    var provider: String?
    /// Picker section override: "dial" / "orchestrator" presets.
    var group: String?
    /// One-line subtitle (dial/orchestrator presets only today).
    var description: String?
    /// Reasoning-effort variants this model supports (may be empty — presets).
    var efforts: [String]?
    var fastModeSupported: Bool?

    var displayLabel: String { label ?? id }
    var isPreset: Bool { group != nil }
}

/// One execution engine from `GET /api/models`. `available` is optional so an
/// older server that only sent an id and label still leaves the engine usable.
struct ModelEngineOption: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var label: String
    var available: Bool?

    var isAvailable: Bool { available != false }
}

/// `GET /api/models`: the pickable catalog, interactive default, and the
/// routing choices that can carry each model.
struct ModelCatalog: Decodable, Sendable {
    var models: [ModelOption]
    var defaultModel: String?
    var engines: [ModelEngineOption]?
    var modelEngines: [String: String]?

    enum CodingKeys: String, CodingKey {
        case models
        case defaultModel = "default"
        case engines
        case modelEngines
    }

    var presets: [ModelOption] { models.filter(\.isPreset) }
    var regular: [ModelOption] { models.filter { !$0.isPreset } }
    var availableEngines: [ModelEngineOption] {
        guard let engines else {
            return [ModelEngineOption(id: "opencode", label: "OpenCode", available: true)]
        }
        return engines.filter(\.isAvailable)
    }

    private static let routedEngines = ["pi", "claude", "codex"]
    private static let presetHeads = ["dial/", "orchestrator/", "workspace-preset/"]

    private static func isPresetID(_ id: String) -> Bool {
        presetHeads.contains { id.hasPrefix($0) }
    }

    /// The engine named explicitly by an id. An unprefixed picker id runs on
    /// OpenCode unless the server applies a per-model default at dispatch.
    static func engine(_ id: String) -> String {
        for engine in routedEngines where id.hasPrefix("\(engine)/") {
            return engine
        }
        return "opencode"
    }

    static func baseID(_ id: String) -> String {
        let engine = engine(id)
        guard engine != "opencode" else { return id }
        let tail = String(id.dropFirst(engine.count + 1))
        return isPresetID(tail) ? tail : "opencode/\(tail)"
    }

    static func routedID(_ id: String, engine: String) -> String? {
        let base = baseID(id)
        guard engine != "opencode" else { return base }
        let tail: String
        if base.hasPrefix("opencode/") {
            tail = String(base.dropFirst("opencode/".count))
        } else if isPresetID(base) {
            tail = base
        } else {
            return nil
        }
        if engine == "claude" || engine == "codex",
           let vendor = vendor(base),
           vendor != (engine == "claude" ? "anthropic" : "openai") {
            return nil
        }
        guard routedEngines.contains(engine) else { return nil }
        return "\(engine)/\(tail)"
    }

    /// The upstream provider segment in an OpenCode picker id. Presets name
    /// their own models and therefore have no single vendor.
    static func vendor(_ id: String) -> String? {
        let base = baseID(id)
        guard base.hasPrefix("opencode/") else { return nil }
        let parts = base.split(separator: "/", maxSplits: 2)
        return parts.count == 3 ? String(parts[1]) : nil
    }

    /// Key shape used by the server's `modelEngines` map: the model slug for
    /// normal models, or the whole preset id.
    static func engineKey(_ id: String) -> String {
        let base = baseID(id)
        guard base.hasPrefix("opencode/") else { return base }
        let tail = String(base.dropFirst("opencode/".count))
        guard let slash = tail.firstIndex(of: "/") else { return tail }
        return String(tail[tail.index(after: slash)...])
    }

    /// Explicit prefixes win. Otherwise mirror the server's fail-soft
    /// per-model default so an unavailable or incompatible preference still
    /// reads as OpenCode in the picker.
    func routingEngine(for id: String) -> String {
        let explicit = Self.engine(id)
        if explicit != "opencode" { return explicit }
        guard let preferred = modelEngines?[Self.engineKey(id)],
              availableEngines.contains(where: { $0.id == preferred }),
              Self.routedID(id, engine: preferred) != nil
        else { return "opencode" }
        return preferred
    }

    /// The id a NEW session should start on for somebody whose personal
    /// default engine is `engine` ("" = no preference). Engine lives in the
    /// model id and nowhere else, and a bare picker id is what the composer
    /// sends both for a deliberate OpenCode pick and for no pick at all — so
    /// the preference can only be applied to the id the composer starts with,
    /// never to one already chosen. Fail-soft: an engine this instance no
    /// longer offers, and a model that cannot route to it, both keep the
    /// unprefixed id rather than starting a session that cannot run. Mirrors
    /// preferredNewSessionModel in the web's lib/new-session-model.
    func preferredID(_ id: String, engine: String) -> String {
        guard !engine.isEmpty,
              engine != "opencode",
              availableEngines.contains(where: { $0.id == engine }),
              let routed = Self.routedID(id, engine: engine)
        else { return id }
        return routed
    }

    func option(for id: String?) -> ModelOption? {
        guard let id, !id.isEmpty else { return nil }
        let base = Self.baseID(id)
        return models.first { $0.id == base }
    }

    /// Short human label for a model id ("Sonnet 5", "Medium"), falling back
    /// to the id's last path segment for ids the catalog doesn't know.
    func label(for id: String?) -> String {
        guard let id, !id.isEmpty else { return "Default" }
        if let option = option(for: id) { return option.displayLabel }
        return id.components(separatedBy: "/").last ?? id
    }
}

/// Display names for the server's reasoning-effort levels.
enum EffortLevel {
    static func label(_ effort: String) -> String {
        switch effort {
        case "none": "None"
        case "low": "Low"
        case "medium": "Medium"
        case "high": "High"
        case "xhigh": "Extra high"
        case "max": "Max"
        default: effort.capitalized
        }
    }
}
