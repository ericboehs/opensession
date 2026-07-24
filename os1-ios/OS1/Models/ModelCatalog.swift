import Foundation

/// One row from `GET /api/models` — a pickable model or preset. Tolerant
/// decoding (everything but `id` optional) so server additions never break us.
struct ModelOption: Decodable, Identifiable, Hashable {
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

/// `GET /api/models`: the pickable catalog plus the interactive default id.
struct ModelCatalog: Decodable {
    var models: [ModelOption]
    var defaultModel: String?

    enum CodingKeys: String, CodingKey {
        case models
        case defaultModel = "default"
    }

    var presets: [ModelOption] { models.filter(\.isPreset) }
    var regular: [ModelOption] { models.filter { !$0.isPreset } }

    func option(for id: String?) -> ModelOption? {
        guard let id, !id.isEmpty else { return nil }
        return models.first { $0.id == id }
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
