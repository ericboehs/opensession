import SwiftStreamingMarkdown
import SwiftUI

/// CommonMark/GFM rendering for durable assistant messages. Parsing and
/// renderable-document construction happen asynchronously inside the library.
struct MarkdownBody: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        SwiftStreamingMarkdown.MarkdownView(text: text, config: .os1Static)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Bridges OS1's coalesced full-text snapshots to the library's streaming API.
/// Buffering only the newest value avoids parsing stale snapshots when parsing
/// briefly falls behind incoming text.
final class MarkdownStreamSource: ObservableObject, StreamedMarkdownSource {
    let text: AsyncStream<String>
    private let continuation: AsyncStream<String>.Continuation

    init(initialText: String) {
        let stream = AsyncStream.makeStream(
            of: String.self,
            bufferingPolicy: .bufferingNewest(1)
        )
        text = stream.stream
        continuation = stream.continuation
        continuation.yield(initialText)
    }

    func update(_ text: String) {
        continuation.yield(text)
    }

    deinit {
        continuation.finish()
    }
}

/// Persistent streamed renderer for the in-flight assistant bubble. The source
/// survives SwiftUI body updates, so snapshots flow through one parser and one
/// rendered document instead of recreating the renderer on every 8 Hz flush.
struct StreamingMarkdownBody: View {
    let text: String
    @StateObject private var source: MarkdownStreamSource

    init(_ text: String) {
        self.text = text
        _source = StateObject(wrappedValue: MarkdownStreamSource(initialText: text))
    }

    var body: some View {
        StreamedMarkdownView(source: source, config: .os1Streaming)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onChange(of: text) { _, newText in
                source.update(newText)
            }
    }
}

private extension MarkdownRenderConfig {
    static let os1Static = MarkdownRenderConfig.default
        .withBlockSpacing(value: 8)
        .withShouldAnimateText(value: false)

    static let os1Streaming = MarkdownRenderConfig.default
        .withBlockSpacing(value: 8)
        .withShouldAnimateText(value: true)
}
