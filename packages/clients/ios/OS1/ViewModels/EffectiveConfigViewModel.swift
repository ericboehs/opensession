import Foundation

@MainActor
@Observable
final class EffectiveConfigViewModel {
    struct DisplayRow: Identifiable, Equatable {
        let id: String
        let label: String
        let values: [String]
        let source: String
        let note: String?
        let forecast: Bool
    }

    typealias Loader = (String) async throws -> SessionEffectiveConfig

    private(set) var config: SessionEffectiveConfig?
    private(set) var isLoading = false
    private(set) var error: String?

    private let loader: Loader
    private var request = 0

    init(loader: @escaping Loader = { try await OS1API.effectiveConfig(sessionId: $0) }) {
        self.loader = loader
    }

    func load(sessionId: String) async {
        request += 1
        let currentRequest = request
        isLoading = true
        error = nil
        do {
            let next = try await loader(sessionId)
            guard currentRequest == request else { return }
            config = next
        } catch {
            guard currentRequest == request else { return }
            self.error = error.localizedDescription
        }
        guard currentRequest == request else { return }
        isLoading = false
    }

    var modelRows: [DisplayRow] {
        guard let config else { return [] }
        var rows: [DisplayRow] = []
        append("resolved-model", "Resolved model", config.model?["dispatchModel"], to: &rows)
        if config.model?["requested"]?.value != config.model?["dispatchModel"]?.value {
            append("requested-model", "Requested", config.model?["requested"], to: &rows)
        }
        append("engine", "Engine", config.model?["engine"], to: &rows)
        append("account", "Account", config.account?["predicted"] ?? config.account?["pinned"], to: &rows)
        return rows
    }

    var mcpRows: [DisplayRow] {
        guard let mcp = config?.mcp else { return [] }
        var rows: [DisplayRow] = []
        append("mcp-scope", "Scope", mcp.scope, to: &rows)

        let included = (mcp.servers ?? []).filter { $0.included == true }
        let excluded = (mcp.servers ?? []).filter { $0.included != true }
        if !included.isEmpty {
            rows.append(DisplayRow(
                id: "mcp-visible",
                label: "Visible servers",
                values: included.map { server in
                    var details = [server.reason, server.transport].compactMap { $0 }
                    if server.oauthGrant == true { details.append("OAuth grant") }
                    return details.isEmpty
                        ? server.name
                        : "\(server.name): \(details.joined(separator: " · "))"
                },
                source: joinedSources(included.compactMap(\.source)),
                note: nil,
                forecast: false
            ))
        }
        if !excluded.isEmpty {
            rows.append(DisplayRow(
                id: "mcp-hidden",
                label: "Not visible",
                values: excluded.map { server in
                    server.reason.map { "\(server.name): \($0)" } ?? server.name
                },
                source: joinedSources(excluded.compactMap(\.source)),
                note: nil,
                forecast: false
            ))
        }
        append("mcp-in-process", "In-process servers", mcp.inProcess?["servers"], to: &rows)
        return rows
    }

    var instructionRows: [DisplayRow] {
        guard let instructions = config?.instructions else { return [] }
        var rows: [DisplayRow] = []
        append("instruction-channel", "Delivery", instructions["channel"], to: &rows)
        append("instruction-sources", "Sources", instructions["sources"], to: &rows)
        return rows
    }

    var permissionRows: [DisplayRow] {
        guard let config else { return [] }
        var rows: [DisplayRow] = []
        append("permission-mode", "Workspace mode", config.execution?["mode"], to: &rows)
        append("permission-gate", "Run allowed", config.gate?["allowed"], to: &rows)
        if let reason = config.gate?["reason"]?.value, reason != .null {
            append("permission-gate-reason", "Gate reason", config.gate?["reason"], to: &rows)
        }
        append("permission-bash", "Shell", config.tools?["bashPolicy"], to: &rows)

        if let stripped = config.tools?["stripped"],
           case .array(let values) = stripped.value {
            let tools = values.compactMap(EffectiveStrippedTool.init(value:))
            for tool in tools {
                rows.append(DisplayRow(
                    id: "permission-stripped-\(tool.tool)",
                    label: "Removed: \(tool.tool)",
                    values: [tool.reason ?? "Removed from the model's tool list"],
                    source: tool.source ?? stripped.source ?? "Source not reported",
                    note: stripped.note,
                    forecast: stripped.stability == "load-dependent"
                ))
            }
        }
        return rows
    }

    private func append(
        _ id: String,
        _ label: String,
        _ row: EffectiveConfigRow?,
        to rows: inout [DisplayRow]
    ) {
        guard let row, let value = row.value else { return }
        rows.append(DisplayRow(
            id: id,
            label: label,
            values: Self.lines(for: value),
            source: row.source ?? "Source not reported",
            note: row.note,
            forecast: row.stability == "load-dependent"
        ))
    }

    nonisolated static func lines(for value: JSONValue) -> [String] {
        switch value {
        case .array(let values):
            return values.isEmpty ? ["None"] : values.map(compact)
        case .object(let values):
            if values.isEmpty { return ["None"] }
            return values.keys.sorted().map { key in
                "\(sentenceCase(key)): \(compact(values[key] ?? .null))"
            }
        default:
            return [compact(value)]
        }
    }

    nonisolated private static func compact(_ value: JSONValue) -> String {
        switch value {
        case .string(let value): return value
        case .number(let value):
            return value == value.rounded() ? String(Int(value)) : String(value)
        case .bool(let value): return value ? "Yes" : "No"
        case .null: return "None"
        case .array(let values): return values.map(compact).joined(separator: ", ")
        case .object(let values):
            return values.keys.sorted().map { key in
                "\(sentenceCase(key)): \(compact(values[key] ?? .null))"
            }.joined(separator: " · ")
        }
    }

    nonisolated private static func sentenceCase(_ key: String) -> String {
        let words = key.reduce(into: "") { result, character in
            if character.isUppercase, !result.isEmpty { result.append(" ") }
            result.append(character)
        }.lowercased()
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    private func joinedSources(_ sources: [String]) -> String {
        let unique = sources.reduce(into: [String]()) { result, source in
            if !result.contains(source) { result.append(source) }
        }
        return unique.isEmpty ? "Source not reported" : unique.joined(separator: "\n")
    }
}
