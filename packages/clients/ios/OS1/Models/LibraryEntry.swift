import Foundation

/// One row of the instance library (server: `src/server/library.ts`,
/// `GET /api/library`): the catalog of what this instance can be extended
/// with, meaning tools, automations and integrations.
///
/// Decoding is deliberately forgiving. The catalog is DERIVED on the server
/// from the recipes directory, the automation templates and the integration
/// registry, so a newer instance will serve kinds this build has never heard
/// of, and fields that did not exist when it shipped. An unknown kind decodes
/// to `.unknown` and the surface leaves it out, rather than one new row
/// throwing away the whole catalog. Only `id` is required; everything else has
/// a fallback.
///
/// What the app does with it is narrower than the web panel: an automation
/// entry carries the prompt it runs, and that prompt is what the phone starts
/// a session from (`LibraryView` → `NewSessionView`). Tools and integrations
/// are instance configuration, so they decode but do not appear.
struct LibraryEntry: Decodable, Identifiable, Hashable, Sendable {
    /// What kind of thing this is. Unknown carries its raw value so a log or a
    /// later build can tell what it was.
    enum Kind: Hashable, Sendable {
        case tool
        case automation
        case integration
        case unknown(String)

        init(raw: String) {
            switch raw {
            case "tool": self = .tool
            case "automation": self = .automation
            case "integration": self = .integration
            default: self = .unknown(raw)
            }
        }

        var raw: String {
            switch self {
            case .tool: "tool"
            case .automation: "automation"
            case .integration: "integration"
            case .unknown(let value): value
            }
        }
    }

    /// How the web installs it. The phone only distinguishes a finished recipe
    /// from a template you are expected to edit, but the whole set decodes so
    /// the model stays a mirror of the payload.
    enum Install: Hashable, Sendable {
        case oneClick
        case draft
        case guided
        case client
        case unknown(String)

        init(raw: String) {
            switch raw {
            case "one-click": self = .oneClick
            case "draft": self = .draft
            case "guided": self = .guided
            case "client": self = .client
            default: self = .unknown(raw)
            }
        }
    }

    let id: String
    let kind: Kind
    let slug: String
    let name: String
    /// The card's one line. Named `summary` because `description` on a struct
    /// reads like `CustomStringConvertible` and this is neither.
    let summary: String
    let category: String
    /// Integration ids that must be enabled before this does anything.
    let requires: [String]
    let install: Install
    /// From the repository (a recipe) rather than built in.
    let fromRepo: Bool
    /// Automations only: the prompt this would run.
    let prompt: String?
    /// "ask" or "code", as the composer spells it.
    let mode: String?
    let model: String?

    /// Whether this row can start a session: an automation whose prompt the
    /// server sent. A server that predates the prompt field serves automations
    /// with none, and the list says so rather than offering a dead row.
    var isStartable: Bool {
        guard case .automation = kind else { return false }
        return !(prompt ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private enum CodingKeys: String, CodingKey {
        case id, type, slug, name, description, category, requires
        case install, source, prompt, mode, model
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = Kind(raw: (try? container.decode(String.self, forKey: .type)) ?? "")
        slug = (try? container.decode(String.self, forKey: .slug)) ?? id
        name = (try? container.decode(String.self, forKey: .name)) ?? slug
        summary = (try? container.decode(String.self, forKey: .description)) ?? ""
        category = (try? container.decode(String.self, forKey: .category)) ?? ""
        requires = (try? container.decode([String].self, forKey: .requires)) ?? []
        install = Install(raw: (try? container.decode(String.self, forKey: .install)) ?? "")
        fromRepo = (try? container.decode(String.self, forKey: .source)) == "repo"
        prompt = try? container.decode(String.self, forKey: .prompt)
        mode = try? container.decode(String.self, forKey: .mode)
        model = try? container.decode(String.self, forKey: .model)
    }
}
