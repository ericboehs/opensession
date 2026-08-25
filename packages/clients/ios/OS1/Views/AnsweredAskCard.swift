import SwiftUI

/// A durable receipt for an answer sent through `AskQuestionCard`. It keeps the
/// question and every offered option in the transcript, with the exact choice
/// clearly marked.
struct AnsweredAskCard: View {
    let ask: AnsweredAsk

    private static let optionLetters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")

    private var loneQuestion: AnsweredAsk.Question? {
        ask.questions.count == 1 ? ask.questions.first : nil
    }

    private var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            ForEach(Array(ask.questions.enumerated()), id: \.offset) { _, question in
                questionReceipt(question)
            }
        }
        .padding(14)
        .frame(maxWidth: 600, alignment: .leading)
        .background(OS1VisualStyle.flapSurface, in: cardShape)
        .overlay(cardShape.stroke(OS1VisualStyle.border, lineWidth: 0.5))
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.green)
            Text(
                ask.questions.count == 1
                    ? "Answer sent"
                    : "\(ask.questions.count) answers sent"
            )
            .font(.footnote.weight(.semibold))
            .foregroundStyle(OS1VisualStyle.textDim)

            if let topic = loneQuestion?.header, !topic.isEmpty {
                Text("·")
                    .foregroundStyle(OS1VisualStyle.textFaint)
                Text(topic)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.textFaint)
            }
        }
    }

    private func questionReceipt(_ question: AnsweredAsk.Question) -> some View {
        let state = AnsweredAsk.state(of: question)
        let options = question.options ?? []

        return VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                if loneQuestion == nil,
                   let header = question.header,
                   !header.isEmpty {
                    Text(header)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(OS1VisualStyle.textFaint)
                }
                Text(question.question)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 2) {
                ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                    choiceRow(
                        letter: index < Self.optionLetters.count
                            ? String(Self.optionLetters[index])
                            : "–",
                        label: option.label,
                        description: option.description,
                        selected: state.selected.contains(option.label)
                    )
                }
                ForEach(Array(state.typed.enumerated()), id: \.offset) { _, answer in
                    choiceRow(
                        letter: "–",
                        label: answer,
                        description: options.isEmpty ? nil : "Custom answer",
                        selected: true
                    )
                }
                if question.answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    choiceRow(letter: "–", label: "No answer", selected: true)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func choiceRow(
        letter: String,
        label: String,
        description: String? = nil,
        selected: Bool
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Text(letter)
                .font(.caption2)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .frame(width: 14, alignment: .leading)

            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.subheadline.weight(selected ? .semibold : .medium))
                    .foregroundStyle(selected ? OS1VisualStyle.text : OS1VisualStyle.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                if let description, !description.isEmpty {
                    Text(description)
                        .font(.footnote)
                        .foregroundStyle(
                            selected ? OS1VisualStyle.textDim : OS1VisualStyle.textFaint
                        )
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 0)
            Image(systemName: "checkmark.circle.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.green)
                .opacity(selected ? 1 : 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            selected ? OS1VisualStyle.hover : Color.clear,
            in: RoundedRectangle(cornerRadius: 7, style: .continuous)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(selected ? "\(label), selected" : label)
    }
}
