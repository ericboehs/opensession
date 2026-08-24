import Foundation

/// One agent a workflow run fanned out.
///
/// Mirrors the server's `WorkflowAgentSnapshot` (`src/shared/workflow-types.ts`).
/// The wire carries more than this: a prompt preview, token counts, a write
/// agent's branch and diffstat, whether the result was replayed from the
/// journal. None of those are why a person opens this on a phone, so they are
/// not decoded — what is kept is the label, where it got to, and how to read
/// what it actually did.
struct WorkflowAgent: Decodable, Sendable, Hashable, Identifiable {
    let seq: Int
    let label: String
    /// The phase the run was in when this was called. The list groups by it.
    let phase: String?
    let model: String?
    let status: WorkflowAgentStatus
    /// The first of the agent's answer, for the rows that finished. The whole
    /// answer is in the conversation behind the row.
    let resultPreview: String?
    let error: String?
    let startedAt: String?
    let endedAt: String?
    /// The engine session this ran in. Its presence is what says a
    /// conversation exists to open — the server sets it the moment the run
    /// starts, so a live agent is readable while it works.
    let engineSessionId: String?

    var id: Int { seq }

    private enum CodingKeys: String, CodingKey {
        case seq, label, phase, model, status, resultPreview, error
        case startedAt, endedAt, engineSessionId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seq = try container.decode(Int.self, forKey: .seq)
        label = (try? container.decode(String.self, forKey: .label)) ?? "Agent \(seq + 1)"
        phase = (try? container.decodeIfPresent(String.self, forKey: .phase)) ?? nil
        model = (try? container.decodeIfPresent(String.self, forKey: .model)) ?? nil
        status = (try? container.decode(WorkflowAgentStatus.self, forKey: .status)) ?? .unknown
        resultPreview = (try? container.decodeIfPresent(String.self, forKey: .resultPreview)) ?? nil
        error = (try? container.decodeIfPresent(String.self, forKey: .error)) ?? nil
        startedAt = (try? container.decodeIfPresent(String.self, forKey: .startedAt)) ?? nil
        endedAt = (try? container.decodeIfPresent(String.self, forKey: .endedAt)) ?? nil
        engineSessionId =
            (try? container.decodeIfPresent(String.self, forKey: .engineSessionId)) ?? nil
    }

    /// For tests and previews.
    init(
        seq: Int,
        label: String,
        phase: String? = nil,
        model: String? = nil,
        status: WorkflowAgentStatus = .done,
        resultPreview: String? = nil,
        error: String? = nil,
        startedAt: String? = nil,
        endedAt: String? = nil,
        engineSessionId: String? = nil
    ) {
        self.seq = seq
        self.label = label
        self.phase = phase
        self.model = model
        self.status = status
        self.resultPreview = resultPreview
        self.error = error
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.engineSessionId = engineSessionId
    }

    /// Whether there is a conversation to push. A pending agent has not
    /// started one, and a row that opens an empty screen is worse than a row
    /// that does nothing.
    var hasConversation: Bool {
        guard let engineSessionId, !engineSessionId.isEmpty else { return false }
        return true
    }

    /// How long it took, once both ends are known.
    var elapsed: TimeInterval? {
        guard let start = Session.parseISO(startedAt) else { return nil }
        guard let end = Session.parseISO(endedAt) else { return nil }
        let seconds = end.timeIntervalSince(start)
        return seconds >= 0 ? seconds : nil
    }

    /// The line under the label: what it ran on and how long it took. Empty
    /// when the server said neither, so the row draws nothing rather than a
    /// stray separator.
    var detail: String {
        var parts: [String] = []
        if let model, !model.isEmpty { parts.append(TranscriptFormat.modelLabel(model)) }
        if let elapsed { parts.append(WorkflowRun.duration(elapsed)) }
        return parts.joined(separator: " · ")
    }

    /// The one line a finished row shows: what went wrong, else the start of
    /// what it answered.
    var outcomeLine: String? {
        if let error, !error.isEmpty { return error }
        guard let resultPreview else { return nil }
        let trimmed = resultPreview.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// Where one agent got to. An unknown value decodes rather than throws.
enum WorkflowAgentStatus: String, Decodable, Sendable, Hashable {
    case pending
    case running
    case done
    case error
    case cancelled
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WorkflowAgentStatus(rawValue: raw) ?? .unknown
    }

    var isRunning: Bool { self == .running }

    var label: String {
        switch self {
        case .pending: "Waiting"
        case .running: "Running"
        case .done: "Done"
        case .error: "Failed"
        case .cancelled: "Cancelled"
        case .unknown: "Unknown"
        }
    }
}

/// Where a whole run got to.
enum WorkflowRunStatus: String, Decodable, Sendable, Hashable {
    case running
    case done
    case error
    case cancelled
    /// The server was restarted while this was live. Nothing is coming.
    case interrupted
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WorkflowRunStatus(rawValue: raw) ?? .unknown
    }

    var isRunning: Bool { self == .running }

    var label: String {
        switch self {
        case .running: "Running"
        case .done: "Done"
        case .error: "Failed"
        case .cancelled: "Cancelled"
        case .interrupted: "Interrupted"
        case .unknown: "Unknown"
        }
    }
}

/// One run of a workflow this session started: a script that fanned work out
/// across a batch of agents and collected what they said.
///
/// Mirrors the server's `WorkflowRunSnapshot`, decoding the part of it a
/// person reads. Three fields the web panel draws are deliberately absent,
/// because measured against every run this instance has ever stored they are
/// almost never there: the narrator log (36 runs of 248 carry any line at all,
/// 71 lines between them), the tail of direct tool calls (6 runs of 248), and
/// write agents' branches and diffstats (2 runs of 248). Phases are kept, and
/// are the one piece of structure that earns its place: 157 runs of 248 have
/// more than one, and they are what turns forty agents into four things that
/// happened.
struct WorkflowRun: Decodable, Sendable, Hashable, Identifiable {
    let runId: String
    let sessionId: String?
    let name: String
    let description: String?
    let status: WorkflowRunStatus
    /// Phase titles in the order the run reached them.
    let phases: [String]
    let currentPhase: String?
    let agents: [WorkflowAgent]
    let error: String?
    let startedAt: String?
    let endedAt: String?

    var id: String { runId }

    private enum CodingKeys: String, CodingKey {
        case runId, sessionId, name, description, status, phases, currentPhase
        case agents, error, startedAt, endedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runId = try container.decode(String.self, forKey: .runId)
        sessionId = (try? container.decodeIfPresent(String.self, forKey: .sessionId)) ?? nil
        name = (try? container.decode(String.self, forKey: .name)) ?? "Workflow"
        description = (try? container.decodeIfPresent(String.self, forKey: .description)) ?? nil
        status = (try? container.decode(WorkflowRunStatus.self, forKey: .status)) ?? .unknown
        phases = ((try? container.decodeIfPresent([String].self, forKey: .phases)) ?? nil) ?? []
        currentPhase = (try? container.decodeIfPresent(String.self, forKey: .currentPhase)) ?? nil
        agents = ((try? container.decodeIfPresent([WorkflowAgent].self, forKey: .agents)) ?? nil) ?? []
        error = (try? container.decodeIfPresent(String.self, forKey: .error)) ?? nil
        startedAt = (try? container.decodeIfPresent(String.self, forKey: .startedAt)) ?? nil
        endedAt = (try? container.decodeIfPresent(String.self, forKey: .endedAt)) ?? nil
    }

    /// For tests and previews.
    init(
        runId: String,
        sessionId: String? = nil,
        name: String,
        description: String? = nil,
        status: WorkflowRunStatus = .done,
        phases: [String] = [],
        currentPhase: String? = nil,
        agents: [WorkflowAgent] = [],
        error: String? = nil,
        startedAt: String? = nil,
        endedAt: String? = nil
    ) {
        self.runId = runId
        self.sessionId = sessionId
        self.name = name
        self.description = description
        self.status = status
        self.phases = phases
        self.currentPhase = currentPhase
        self.agents = agents
        self.error = error
        self.startedAt = startedAt
        self.endedAt = endedAt
    }

    var started: Date? { Session.parseISO(startedAt) }

    /// Only a live run can be stopped, and only a live run is worth stopping.
    var canCancel: Bool { status.isRunning }

    var finishedAgentCount: Int {
        agents.filter { $0.status == .done || $0.status == .error }.count
    }

    var failedAgentCount: Int { agents.filter { $0.status == .error }.count }

    /// The row's second line: where the run got to, in the fewest words that
    /// are still true.
    ///
    /// A finished run is counted, because the count is the answer to "what did
    /// it do" — and failures are named, because they are the reason to open
    /// it. A live one says which phase it is in instead: how far through it is
    /// is what you want while it runs, and the total is not known yet.
    var progressLine: String {
        if status.isRunning {
            if let currentPhase, !currentPhase.isEmpty {
                return "\(currentPhase) · \(finishedAgentCount) of \(agents.count) agents"
            }
            return "\(finishedAgentCount) of \(agents.count) agents"
        }
        if agents.isEmpty {
            if let error, !error.isEmpty { return error }
            return "No agents ran"
        }
        let noun = agents.count == 1 ? "agent" : "agents"
        if failedAgentCount > 0 {
            return "\(agents.count) \(noun) · \(failedAgentCount) failed"
        }
        return "\(agents.count) \(noun)"
    }

    /// The agents in the order the run made them, bucketed by phase.
    ///
    /// Phase order comes from `phases` because that is the order the run
    /// reached them; anything the script never announced falls in last under
    /// its own name rather than disappearing. A run with one phase or none
    /// gets a single unnamed group, so the view draws a plain list instead of
    /// a section header repeating the run's own title.
    var groupedAgents: [WorkflowPhaseGroup] {
        guard !agents.isEmpty else { return [] }
        var order: [String] = []
        var buckets: [String: [WorkflowAgent]] = [:]
        for agent in agents {
            let key = agent.phase ?? ""
            if buckets[key] == nil {
                buckets[key] = []
                order.append(key)
            }
            buckets[key]?.append(agent)
        }
        if order.count <= 1 {
            return [WorkflowPhaseGroup(title: nil, agents: agents)]
        }
        let announced = phases.filter { buckets[$0] != nil }
        let rest = order.filter { !announced.contains($0) }
        return (announced + rest).compactMap { key in
            guard let bucket = buckets[key] else { return nil }
            return WorkflowPhaseGroup(title: key.isEmpty ? nil : key, agents: bucket)
        }
    }

    /// A duration in the shortest form that is still readable — the same
    /// shape a run row and an agent row both need.
    static func duration(_ seconds: TimeInterval) -> String {
        if seconds < 1 { return "<1s" }
        if seconds < 60 { return "\(Int(seconds.rounded()))s" }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        let remainder = minutes % 60
        return remainder == 0 ? "\(hours)h" : "\(hours)h \(remainder)m"
    }
}

/// One phase of a run and the agents it called, ready to draw as a section.
struct WorkflowPhaseGroup: Sendable, Hashable, Identifiable {
    /// Absent when the run never named its phases — the view then draws no
    /// header at all rather than an empty one.
    let title: String?
    let agents: [WorkflowAgent]

    var id: String { title ?? "" }
}

/// `GET /api/sessions/:id/workflows` — every run this session started,
/// newest first.
struct WorkflowRunsResponse: Decodable, Sendable {
    let runs: [WorkflowRun]

    private enum CodingKeys: String, CodingKey { case runs }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runs = ((try? container.decodeIfPresent([WorkflowRun].self, forKey: .runs)) ?? nil) ?? []
    }
}

/// `GET /api/workflows/:runId/agents/:seq/transcript` — one agent's own
/// conversation, in the same entry shape the main transcript uses.
struct WorkflowAgentTranscript: Decodable, Sendable {
    let entries: [TranscriptEntry]

    private enum CodingKeys: String, CodingKey { case entries }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        entries = ((try? container.decodeIfPresent([TranscriptEntry].self, forKey: .entries)) ?? nil) ?? []
    }

    init(entries: [TranscriptEntry]) { self.entries = entries }
}
