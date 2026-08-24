import Foundation
import SwiftStreamingMarkdown

/// The transcript's inline chips: a session, automation, scratch file or pull request,
/// drawn as an object inside the sentence rather than as coloured words.
///
/// The web draws all four the same way — a quiet wash, a glyph naming what
/// opens, and room around the label (`.session-link`, `.asset-ref`, `.pr-ref`
/// in src/frontend/styles/base.css) — and the PR chip additionally takes its
/// live state as the wash's colour. Natively none of that was reachable:
/// SwiftStreamingMarkdown paints every inline link in ONE colour from
/// `inlineStyle.linkTextColor`, with no per-link hook, which is why the PR
/// chip had settled for a colour emoji as its state dot.
///
/// The way through is the library's inline CITATION, which is not really about
/// citations: it is the one inline element it renders as an `NSTextAttachment`
/// instead of as styled text. A link whose text is a marker and whose
/// destination carries the payload becomes an attachment
/// (`Markdown+InlineConvertible`), and an attachment can be drawn by an
/// `NSTextAttachmentViewProvider` we own — see `TranscriptChipView`. So every
/// chip is a real view with its own colours, its own icon and its own bounds,
/// and the markdown that produces one is still just a link.
///
/// Everything the drawing needs rides in the destination's query, because the
/// payload the library hands the provider is built from the URL. The three
/// schemes read the id out of the URL's path (`SessionLinks.sessionId(from:)`,
/// `PathLinks.path(from:)`, `PrLinks.reference(from:)`), which the query
/// leaves alone, so a tap still lands where it always did.
struct TranscriptChip: Equatable {
    /// What the chip opens, which is also which glyph it wears.
    enum Kind: String {
        case session
        case automation
        case asset
        case pullRequest = "pr"
    }

    /// The wash and label colour. `neutral` is the resting chip; the rest are
    /// the web's PR tones, said in this app's own palette.
    enum Tone: String {
        case neutral
        case accent
        case green
        case yellow
        case red
        case purple
        case gray
    }

    var kind: Kind
    var tone: Tone
    /// What the chip reads as. Already shortened and cleaned by whoever built
    /// it: a chip is a fixed object in a line of text, not a place to spill a
    /// forty-character id.
    var title: String
    /// The whole of what the label abbreviates, for VoiceOver.
    var accessibilityLabel: String
    /// The private-scheme URL a tap opens, without the chip's own query.
    var destination: String

    // MARK: - The wire format

    /// The link text every chip carries. The library matches it literally to
    /// decide a link is a citation, so it is never seen — and a chip whose
    /// payload fails to decode renders as nothing at all rather than as this
    /// string, which is why `markdown` builds the destination rather than
    /// trusting a caller to spell one.
    static let marker = "os1chip"

    private enum Param {
        static let marker = "os1chip"
        static let title = "chipTitle"
        static let accessibilityLabel = "chipLabel"
        static let kind = "chipKind"
        static let tone = "chipTone"
    }

    /// The library's citation format, renamed onto our own parameters so a
    /// transcript URL says what it is. Handed to `MarkdownRenderConfig`'s
    /// `citationConfig` in `MarkdownBody`.
    static let coder = CitationCoder(
        citationMarker: marker,
        citationMarkerQueryParam: Param.marker,
        citationTextQueryParam: Param.title,
        citationA11yTextQueryParam: Param.accessibilityLabel
    )

    /// The markdown for this chip: a link the renderer turns into an
    /// attachment. Falls back to an ordinary link when the title or the
    /// destination can't be encoded, which keeps a chip that can't be drawn
    /// from swallowing the words it was made of.
    var markdown: String {
        guard let encoded = query else {
            return "[\(TranscriptChip.escaped(title))](\(destination))"
        }
        return "[\(TranscriptChip.marker)](\(destination)?\(encoded))"
    }

    private var query: String? {
        let items = [
            (Param.marker, TranscriptChip.marker),
            (Param.title, title),
            (Param.accessibilityLabel, accessibilityLabel),
            (Param.kind, kind.rawValue),
            (Param.tone, tone.rawValue),
        ]
        var encoded: [String] = []
        for (name, value) in items {
            guard let value = value.addingPercentEncoding(
                withAllowedCharacters: TranscriptChip.queryAllowed
            ) else { return nil }
            encoded.append("\(name)=\(value)")
        }
        return encoded.joined(separator: "&")
    }

    /// Deliberately tighter than `.urlQueryAllowed`: a markdown destination
    /// ends at a space and closes at a parenthesis, and `&`, `=`, `#` and `+`
    /// all mean something to a URL's own parser.
    private static let queryAllowed: CharacterSet = {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return allowed
    }()

    /// A title is arbitrary text landing in a markdown link label, so the
    /// characters that would end that label early have to be escaped. Only
    /// reachable through the fallback above; a chip's own title travels
    /// percent-encoded.
    private static func escaped(_ label: String) -> String {
        label
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
    }

    // MARK: - Reading one back

    /// What the view provider draws: the payload the library decoded from the
    /// URL, plus the kind and tone it doesn't know about.
    struct Rendered: Equatable {
        var kind: Kind
        var tone: Tone
        var title: String
        var accessibilityLabel: String
        var url: URL
    }

    /// The chip behind a rendered attachment, from the JSON payload the
    /// library encodes into it. Unknown kinds and tones fall back rather than
    /// failing: a chip drawn plain is better than a sentence with a hole in it.
    static func rendered(payload: Data) -> Rendered? {
        guard let decoded = try? JSONDecoder().decode(Payload.self, from: payload),
              let components = URLComponents(url: decoded.url, resolvingAgainstBaseURL: true)
        else { return nil }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value
        }
        return Rendered(
            kind: value(Param.kind).flatMap(Kind.init(rawValue:)) ?? .session,
            tone: value(Param.tone).flatMap(Tone.init(rawValue:)) ?? .neutral,
            title: decoded.title,
            accessibilityLabel: decoded.accessibilityLabel,
            url: decoded.url
        )
    }

    /// The shape `InlineCitationAttachment` encodes. Mirrored rather than
    /// imported because the library's own struct is internal to it; only the
    /// three fields this app reads are declared, and an extra field on their
    /// side is ignored.
    private struct Payload: Decodable {
        let title: String
        let accessibilityLabel: String
        let url: URL
    }
}
