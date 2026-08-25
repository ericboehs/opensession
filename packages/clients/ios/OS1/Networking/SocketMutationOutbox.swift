import Foundation

/// Durable socket intents. A frame remains here until the server returns its
/// command_result, so reconnect and app relaunch reuse the same request id.
struct SocketMutationOutbox {
    private static let mutationTypes: Set<String> = [
        "prompt", "interrupt_prompt", "delete_queued_prompt", "take_queued_prompt",
        "take_steered_prompt",
        "update_queued_prompt", "steer_queued_prompt", "interrupt_queued_prompt",
        "reorder_queued_prompt", "cancel", "answer_question",
    ]

    private static let maxStoredBytes = 3 * 1_024 * 1_024

    private let defaults: UserDefaults
    private let key: String
    private var ackKey: String { "\(key):acks" }

    static func storageKey(server: String, user: String) -> String {
        "dev.tella.os1.socket-mutations.v1:\(server):\(user)"
    }

    init(
        defaults: UserDefaults = .standard,
        key: String = "dev.tella.os1.socket-mutations.v1"
    ) {
        self.defaults = defaults
        self.key = key
    }

    func prepare(
        _ input: [String: Any],
        persistMutation: Bool = true
    ) -> (frame: [String: Any], text: String)? {
        var frame = input
        let mutation = (frame["type"] as? String).map(Self.mutationTypes.contains) == true
        if mutation, frame["requestId"] == nil {
            frame["requestId"] = UUID().uuidString.lowercased()
        }
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        if persistMutation, let requestId = frame["requestId"] as? String,
           !persist(id: requestId, text: text) {
            return nil
        }
        return (frame, text)
    }

    func pendingTexts() -> [String] {
        defaults.stringArray(forKey: key) ?? []
    }

    func pendingAckTexts() -> [String] {
        defaults.stringArray(forKey: ackKey) ?? []
    }

    @discardableResult
    func acknowledge(id: String, sessionId: String) -> Bool {
        let pending = pendingTexts()
        let next = pending.filter { mutationId(in: $0) != id }
        guard next.count != pending.count,
              let ack = prepare([
                  "type": "command_ack",
                  "sessionId": sessionId,
                  "requestId": id,
              ], persistMutation: false)
        else { return false }
        let previousAcks = pendingAckTexts()
        var acks = previousAcks
        if !acks.contains(where: { mutationId(in: $0) == id }) { acks.append(ack.text) }
        defaults.set(acks, forKey: ackKey)
        guard pendingAckTexts().contains(where: { mutationId(in: $0) == id }) else {
            return false
        }
        defaults.set(next, forKey: key)
        guard !pendingTexts().contains(where: { mutationId(in: $0) == id }) else {
            defaults.set(previousAcks, forKey: ackKey)
            return false
        }
        return true
    }

    @discardableResult
    func retireLegacy(id: String) -> Bool {
        let pending = pendingTexts()
        let next = pending.filter { mutationId(in: $0) != id }
        guard next.count != pending.count else { return false }
        defaults.set(next, forKey: key)
        return !pendingTexts().contains { mutationId(in: $0) == id }
    }

    @discardableResult
    func confirmAcknowledgement(id: String) -> Bool {
        let current = pendingAckTexts()
        let next = current.filter { mutationId(in: $0) != id }
        guard next.count != current.count else { return false }
        defaults.set(next, forKey: ackKey)
        return !pendingAckTexts().contains { mutationId(in: $0) == id }
    }

    private func mutationId(in text: String) -> String? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object["requestId"] as? String
    }

    private func persist(id: String, text: String) -> Bool {
        var pending = pendingTexts()
        if let index = pending.firstIndex(where: { mutationId(in: $0) == id }) {
            pending[index] = text
        } else {
            pending.append(text)
        }
        let bytes = pending.reduce(0) { $0 + $1.utf8.count }
        guard bytes <= Self.maxStoredBytes else { return false }
        defaults.set(pending, forKey: key)
        return pendingTexts() == pending
    }
}
