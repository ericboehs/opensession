import SwiftStreamingMarkdown
import SwiftUI
#if os(macOS)
import AppKit
#endif

/// CommonMark/GFM rendering for durable assistant messages. Parsing and
/// renderable-document construction happen asynchronously inside the library.
struct MarkdownBody: View {
    let text: String
    /// Narration inside a work fold renders dimmer than a final answer — the
    /// library owns its own colours, so a `.foregroundStyle` on the outside
    /// would be ignored.
    var dimmed = false

    init(_ text: String, dimmed: Bool = false) {
        self.text = text
        self.dimmed = dimmed
    }

    var body: some View {
        SwiftStreamingMarkdown.MarkdownView(
            // Session ids become links here rather than in the display pass:
            // the entry's own text stays the raw markdown, so copying a
            // message still yields what the agent actually wrote.
            text: SessionLinks.linkify(text),
            config: dimmed ? .os1Dim : .os1Static
        )
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

#if os(macOS)
private extension TextFonts {
    /// Mac-metric font set. The library's bundled `Typography` ramp hardcodes
    /// iOS point sizes (17pt body, 28pt h1, 15pt code), which read oversized
    /// next to the 13pt-based Mac UI, so the Mac config builds its own fonts.
    static func mac(
        size: CGFloat,
        weight: NSFont.Weight = .regular,
        lineHeight: CGFloat? = nil
    ) -> TextFonts {
        let normal = NSFont.systemFont(ofSize: size, weight: weight)
        let bold = NSFont.systemFont(
            ofSize: size,
            weight: weight == .regular ? .semibold : .bold
        )
        return TextFonts(
            normal: normal,
            italic: italicVariant(of: normal),
            bold: bold,
            boldItalic: italicVariant(of: bold),
            preferredLetterSpacing: nil,
            preferredLineHeight: lineHeight
        )
    }

    private static func italicVariant(of font: NSFont) -> NSFont {
        NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
    }
}
#endif

private extension MarkdownRenderConfig {
    /// `text` is the body colour: full strength for an answer, dimmed for the
    /// narration inside a work fold, which is context rather than conclusion.
    static func os1Config(text: Color) -> MarkdownRenderConfig {
        #if os(iOS)
        let base = MarkdownRenderConfig.default
        return MarkdownRenderConfig(
            blockQuoteStyle: .init(
                textFonts: base.blockQuoteStyle.textFonts,
                textColor: OS1VisualStyle.textDim
            ),
            headingStyle: .init(
                h1Font: base.headingStyle.h1Font,
                h2Font: base.headingStyle.h2Font,
                h3Font: base.headingStyle.h3Font,
                h4Font: base.headingStyle.h4Font,
                h5Font: base.headingStyle.h5Font,
                h6Font: base.headingStyle.h6Font,
                textColor: text
            ),
            orderedListStyle: .init(
                textFonts: base.orderedListStyle.textFonts,
                textColor: text
            ),
            paragraphStyle: .init(
                textFonts: base.paragraphStyle.textFonts,
                textColor: text
            ),
            tableStyle: .init(
                textFonts: base.tableStyle.textFonts,
                headerTextColor: OS1VisualStyle.text,
                regularTextColor: OS1VisualStyle.text,
                headerBackgroundColor: OS1VisualStyle.panel,
                borderColor: OS1VisualStyle.border,
                actionButtonColor: OS1VisualStyle.accent
            ),
            inlineStyle: .init(
                boldTextColor: OS1VisualStyle.text,
                linkTextFont: base.inlineStyle.linkTextFont,
                linkTextColor: OS1VisualStyle.accent,
                codeTextFont: base.inlineStyle.codeTextFont,
                codeTextColor: OS1VisualStyle.text,
                codeBackgroundColor: OS1VisualStyle.panel,
                codeUnderlineColor: OS1VisualStyle.border
            ),
            blockSpacing: 8,
            thematicBreakColor: OS1VisualStyle.border
        )
        #else
        // Same deliberate palette as the iOS branch, at Mac text metrics:
        // 13pt body on a 19pt line, headings stepped 20/17/15/14/13, 12pt
        // code, and a 12pt block gap for readable paragraph rhythm.
        let body = TextFonts.mac(size: 13, lineHeight: 19)
        return MarkdownRenderConfig(
            blockQuoteStyle: .init(textFonts: body, textColor: OS1VisualStyle.textDim),
            headingStyle: .init(
                h1Font: .mac(size: 20, weight: .bold),
                h2Font: .mac(size: 17, weight: .semibold),
                h3Font: .mac(size: 15, weight: .semibold),
                h4Font: .mac(size: 14, weight: .semibold),
                h5Font: .mac(size: 13, weight: .semibold),
                h6Font: .mac(size: 13, weight: .semibold),
                textColor: text
            ),
            orderedListStyle: .init(textFonts: body, textColor: text),
            paragraphStyle: .init(textFonts: body, textColor: text),
            tableStyle: .init(
                textFonts: .mac(size: 12),
                headerTextColor: OS1VisualStyle.text,
                regularTextColor: OS1VisualStyle.text,
                headerBackgroundColor: OS1VisualStyle.panel,
                borderColor: OS1VisualStyle.border,
                actionButtonColor: OS1VisualStyle.accent
            ),
            inlineStyle: .init(
                boldTextColor: OS1VisualStyle.text,
                linkTextFont: .systemFont(ofSize: 13),
                linkTextColor: OS1VisualStyle.accent,
                codeTextFont: .monospacedSystemFont(ofSize: 12, weight: .regular),
                codeTextColor: OS1VisualStyle.text,
                codeBackgroundColor: OS1VisualStyle.panel,
                codeUnderlineColor: OS1VisualStyle.border
            ),
            blockSpacing: 12,
            thematicBreakColor: OS1VisualStyle.border
        )
        #endif
    }

    static let os1Base = os1Config(text: OS1VisualStyle.text)

    static let os1Static = os1Base
        .withShouldAnimateText(value: false)

    static let os1Dim = os1Config(text: OS1VisualStyle.textDim)
        .withShouldAnimateText(value: false)

    static let os1Streaming = os1Base
        .withShouldAnimateText(value: true)
}
