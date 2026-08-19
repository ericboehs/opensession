import SwiftUI

/// The session is blocked on an AskUserQuestion — render the first question's
/// options as tappable rows plus a free-text field. Answers are keyed by
/// question text, matching the server's `answer_question` frame.
///
/// Deliberately monochrome. The card used to be a tinted orange glass pane
/// with an ALL-CAPS header, which shouted louder than anything else in the
/// transcript for what is usually a routine fork in the work. It now reads as
/// a quiet inset list on the app's own neutral surface: one hairline border,
/// hairline-separated rows, and — for the free-text answer — the same
/// accent-filled send disc the composer wears, so answering here feels like
/// writing a message rather than filling in a form.
struct AskQuestionCard: View {
    let ask: AskQuestion
    let onAnswer: ([String: String]?) -> Void

    @State private var freeText = ""
    /// The row that was tapped, so it can confirm the choice for the moment
    /// between the tap and the server retiring the card.
    @State private var chosen: String?
    @FocusState private var inputFocused: Bool

    private var question: AskQuestion.Question? { ask.questions.first }

    private var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
    }

    private var trimmedFreeText: String {
        freeText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let question {
                prompt(question)

                ForEach(question.options ?? [], id: \.label) { option in
                    hairline
                    optionRow(option, in: question)
                }

                hairline
                freeTextRow(question)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The app's neutral raised surface: a shade under the page in light,
        // a shade over it in dark — the one direction each appearance leaves.
        .background(OS1VisualStyle.flapSurface, in: cardShape)
        .overlay(cardShape.stroke(OS1VisualStyle.border, lineWidth: 0.5))
        .animation(.snappy(duration: 0.2), value: chosen)
        .animation(.snappy(duration: 0.2), value: trimmedFreeText.isEmpty)
        // Answering is the moment a stuck session starts moving again — worth
        // the success cue rather than a send's tap, and it covers both ways of
        // answering because both set `chosen`.
        .haptic(trigger: chosen) { previous, chosen in
            previous == nil && chosen != nil ? .commit : nil
        }
    }

    // MARK: - Pieces

    private func prompt(_ question: AskQuestion.Question) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if let header = question.header, !header.isEmpty {
                // Sentence case, as written. Uppercasing a header the model
                // wrote ("Which app") turned a label into a shout.
                Text(header)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            Text(question.question)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 13)
    }

    private func optionRow(
        _ option: AskQuestion.Option,
        in question: AskQuestion.Question
    ) -> some View {
        Button {
            guard chosen == nil else { return }
            chosen = option.label
            onAnswer([question.question: option.label])
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.text)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
                // Nothing at rest — a chevron would promise navigation, and
                // tapping answers instead. The checkmark only marks the row
                // that was picked.
                Image(systemName: "checkmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.text)
                    .opacity(chosen == option.label ? 1 : 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
        }
        .buttonStyle(AskOptionButtonStyle())
        // The unpicked rows step back once a choice is in flight, so the card
        // reads as answered rather than still waiting.
        .opacity(chosen == nil || chosen == option.label ? 1 : 0.4)
        .disabled(chosen != nil)
    }

    private func freeTextRow(_ question: AskQuestion.Question) -> some View {
        HStack(alignment: .bottom, spacing: 6) {
            TextField("Answer in your own words", text: $freeText, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.subheadline)
                .lineLimit(1...5)
                .focused($inputFocused)
                .frame(maxWidth: .infinity, minHeight: 32)
                .padding(.leading, 12)
                .onSubmit(sendFreeText)

            // Send only exists once there is something to send: an always-on
            // disabled button beside an empty field is noise, and the disc is
            // the composer's, so the gesture is already learned.
            if !trimmedFreeText.isEmpty {
                Button(action: sendFreeText) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(OS1VisualStyle.onAccent)
                        .frame(width: 28, height: 28)
                        .background(OS1VisualStyle.accent, in: Circle())
                }
                .buttonStyle(.plain)
                .contentShape(Circle())
                .accessibilityLabel("Send answer")
                .transition(.scale(scale: 0.6).combined(with: .opacity))
            }
        }
        .padding(4)
        .background(
            OS1VisualStyle.hover,
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onTapGesture { inputFocused = true }
        .disabled(chosen != nil)
    }

    private var hairline: some View {
        Rectangle()
            .fill(OS1VisualStyle.border)
            .frame(height: 0.5)
            .frame(maxWidth: .infinity)
    }

    private func sendFreeText() {
        guard let question, chosen == nil else { return }
        let text = trimmedFreeText
        guard !text.isEmpty else { return }
        chosen = text
        inputFocused = false
        onAnswer([question.question: text])
    }
}

/// Row press feedback: the whole row lights, edge to edge, the way a grouped
/// list row does — a scale or an opacity dip on a full-width row reads as the
/// card itself flinching.
private struct AskOptionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? OS1VisualStyle.hover : .clear)
            .contentShape(Rectangle())
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
