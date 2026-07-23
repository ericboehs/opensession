import SwiftUI

/// The session is blocked on an AskUserQuestion — render the first question's
/// options as tappable buttons plus a free-text field. Answers are keyed by
/// question text, matching the server's `answer_question` frame.
struct AskQuestionCard: View {
    let ask: AskQuestion
    let onAnswer: ([String: String]?) -> Void

    @State private var freeText = ""

    private var question: AskQuestion.Question? { ask.questions.first }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let question {
                if let header = question.header, !header.isEmpty {
                    Text(header.uppercased())
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                Text(question.question)
                    .font(.subheadline.weight(.medium))

                ForEach(question.options ?? [], id: \.label) { option in
                    Button {
                        onAnswer([question.question: option.label])
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label)
                                .font(.subheadline)
                            if let description = option.description, !description.isEmpty {
                                Text(description)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }

                HStack(spacing: 8) {
                    TextField("Answer…", text: $freeText, axis: .vertical)
                        .lineLimit(1...3)
                        .textFieldStyle(.roundedBorder)
                    Button("Send") {
                        let text = freeText.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else { return }
                        onAnswer([question.question: text])
                    }
                    .disabled(freeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(.orange.opacity(0.5), lineWidth: 1)
        )
    }
}
