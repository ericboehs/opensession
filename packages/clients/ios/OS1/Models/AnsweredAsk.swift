import Foundation

/// The durable record of an answered question card (`AnsweredAskData` in
/// protocol notices.ts). Rides the classified notice as `notice.ask`, with
/// the raw entry's `ask` as the compatibility spot; the notice's title and
/// markdown body remain what clients without this type render.
struct AnsweredAsk: Decodable, Equatable, Sendable {
    struct Option: Decodable, Equatable, Sendable {
        let label: String
        let description: String?
    }

    struct Question: Decodable, Equatable, Sendable {
        let question: String
        let header: String?
        let options: [Option]?
        let multiSelect: Bool?
        /// What was chosen: an option label, free text, or for a
        /// multi-select the picked labels joined with ", ".
        let answer: String
    }

    let version: Int?
    let questions: [Question]

    /// Which offered options the answer selected, and which parts were typed
    /// by hand. Mirrors the web's answerState: a single-select answer that
    /// matches no option is one typed answer whole (labels may contain
    /// commas, so no split), while a multi-select splits on commas and sorts
    /// unknown parts into typed answers.
    static func state(of question: Question) -> (selected: Set<String>, typed: [String]) {
        let answer = question.answer.trimmingCharacters(in: .whitespacesAndNewlines)
        if answer.isEmpty { return ([], []) }
        let options = question.options ?? []
        if question.multiSelect != true {
            if options.contains(where: { $0.label == answer }) {
                return ([answer], [])
            }
            return ([], [answer])
        }
        let parts = answer.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let labels = Set(options.map(\.label))
        return (
            Set(parts.filter { labels.contains($0) }),
            parts.filter { !labels.contains($0) }
        )
    }
}

extension AnsweredAsk {
    /// Build the same receipt shape immediately from the answer sent on the wire.
    init(question: AskQuestion, answers: [String: String]) {
        self.init(
            version: 1,
            questions: question.questions.map { asked in
                Question(
                    question: asked.question,
                    header: asked.header,
                    options: asked.options?.map {
                        Option(label: $0.label, description: $0.description)
                    },
                    multiSelect: asked.multiSelect,
                    answer: answers[asked.question] ?? ""
                )
            }
        )
    }
}

/// An answer shown until the matching durable transcript record arrives.
struct SentAskAnswer: Identifiable, Equatable, Sendable {
    let id: String
    let ask: AnsweredAsk
    let existingRecordIDs: Set<String>
}
