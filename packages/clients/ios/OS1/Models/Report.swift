import Foundation

/// A document an automation published: the morning support digest, a spend
/// analysis, an error sweep.
///
/// Mirrors the server's `ReportMeta` (`src/server/reports.ts`), which is the
/// JSON sidecar beside an HTML file. The document itself is never in this
/// payload — it is fetched from `/api/reports/:automationId/:reportId/raw`,
/// and reading it is what the screen is for. Everything here exists to answer
/// one question before you open it: is this the one I want.
///
/// Decoded tolerantly, like every other model here. Only `id` is required;
/// `urgency` and `confidence` decode an unknown word rather than throwing the
/// row away, because the server may grow a level this build has never heard
/// of and a report with a strange urgency is still a report worth reading.
struct ReportMeta: Decodable, Sendable, Hashable, Identifiable {
    let id: String
    let title: String
    let automationId: String
    /// The automation's name as it was when this was published, so a rename
    /// does not rewrite history.
    let automationName: String
    /// The run that wrote it, when the server recorded one.
    let sessionId: String?
    let createdAt: String?
    /// A plain-text gist. The list row's second line.
    let summary: String?
    let urgency: ReportUrgency?
    let confidence: ReportConfidence?

    private enum CodingKeys: String, CodingKey {
        case id, title, automationId, automationName, sessionId, createdAt
        case summary, urgency, confidence
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = (try? container.decode(String.self, forKey: .title)) ?? "Untitled report"
        automationId = (try? container.decode(String.self, forKey: .automationId)) ?? ""
        automationName = (try? container.decode(String.self, forKey: .automationName)) ?? ""
        sessionId = (try? container.decodeIfPresent(String.self, forKey: .sessionId)) ?? nil
        createdAt = (try? container.decodeIfPresent(String.self, forKey: .createdAt)) ?? nil
        summary = (try? container.decodeIfPresent(String.self, forKey: .summary)) ?? nil
        urgency = (try? container.decodeIfPresent(ReportUrgency.self, forKey: .urgency)) ?? nil
        confidence =
            (try? container.decodeIfPresent(ReportConfidence.self, forKey: .confidence)) ?? nil
    }

    /// For tests and previews.
    init(
        id: String,
        title: String,
        automationId: String,
        automationName: String = "",
        sessionId: String? = nil,
        createdAt: String? = nil,
        summary: String? = nil,
        urgency: ReportUrgency? = nil,
        confidence: ReportConfidence? = nil
    ) {
        self.id = id
        self.title = title
        self.automationId = automationId
        self.automationName = automationName
        self.sessionId = sessionId
        self.createdAt = createdAt
        self.summary = summary
        self.urgency = urgency
        self.confidence = confidence
    }

    var published: Date? { Session.parseISO(createdAt) }

    /// The one badge a row carries, or nothing.
    ///
    /// The web prints both words next to each other ("high urgency · high
    /// confidence"). On a phone that is two thirds of the row's width spent on
    /// a distinction that only changes how hard you read, so the badge is the
    /// urgency alone and confidence goes to the document header, where there
    /// is room to say it in full. Most reports carry neither: two thirds of
    /// the groups on this instance publish no urgency at all, and a badge that
    /// is usually absent is worth more when it appears.
    var signal: ReportUrgency? {
        guard let urgency, urgency != .low else { return nil }
        return urgency
    }

    /// What the document header says under the title, when the automation had
    /// something to say about how sure it is.
    var confidenceNote: String? {
        guard let confidence, confidence != .unknown else { return nil }
        return "\(confidence.label) confidence"
    }
}

/// How soon the report's most urgent finding needs someone. Unknown values
/// decode rather than throw: a server that grows a level must not blank a
/// list this app can otherwise render.
enum ReportUrgency: String, Decodable, Sendable, Hashable {
    case low
    case medium
    case high
    case critical
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ReportUrgency(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .critical: "Critical"
        case .unknown: "Flagged"
        }
    }
}

/// How sure the automation is of its own assessment.
enum ReportConfidence: String, Decodable, Sendable, Hashable {
    case low
    case medium
    case high
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ReportConfidence(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .unknown: "Unstated"
        }
    }
}

/// One automation that publishes reports, with its newest one already in
/// hand — which is why the list can show what happened without a second
/// request, and why tapping a row opens the document rather than another list.
struct ReportGroup: Decodable, Sendable, Hashable, Identifiable {
    let automationId: String
    let automationName: String
    let count: Int
    let latest: ReportMeta

    var id: String { automationId }

    private enum CodingKeys: String, CodingKey {
        case automationId, automationName, count, latest
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        latest = try container.decode(ReportMeta.self, forKey: .latest)
        automationId =
            (try? container.decode(String.self, forKey: .automationId)) ?? latest.automationId
        automationName =
            (try? container.decode(String.self, forKey: .automationName))
            ?? latest.automationName
        count = (try? container.decode(Int.self, forKey: .count)) ?? 1
    }

    init(automationId: String, automationName: String, count: Int, latest: ReportMeta) {
        self.automationId = automationId
        self.automationName = automationName
        self.count = count
        self.latest = latest
    }

    /// The name to draw, falling back to the report's own record of it rather
    /// than an empty row.
    var name: String {
        if !automationName.isEmpty { return automationName }
        if !latest.automationName.isEmpty { return latest.automationName }
        return automationId
    }
}

/// `GET /api/reports` — one row per automation that has ever published.
struct ReportGroupsResponse: Decodable, Sendable {
    let groups: [ReportGroup]

    private enum CodingKeys: String, CodingKey { case groups }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        groups = ((try? container.decodeIfPresent([ReportGroup].self, forKey: .groups)) ?? nil) ?? []
    }
}

/// `GET /api/reports/:automationId` — that automation's history, newest first.
struct ReportHistoryResponse: Decodable, Sendable {
    let reports: [ReportMeta]

    private enum CodingKeys: String, CodingKey { case reports }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reports = ((try? container.decodeIfPresent([ReportMeta].self, forKey: .reports)) ?? nil) ?? []
    }
}
