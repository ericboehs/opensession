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
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label)
                                    .font(.subheadline.weight(.medium))
                                if let description = option.description, !description.isEmpty {
                                    Text(description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(
                            .background.opacity(0.5),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }

                HStack(spacing: 8) {
                    TextField("Or answer in your own words…", text: $freeText, axis: .vertical)
                        .lineLimit(1...3)
                        .textFieldStyle(.roundedBorder)
                    Button("Send") {
                        let text = freeText.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else { return }
                        onAnswer([question.question: text])
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .disabled(freeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(tint: .orange, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
