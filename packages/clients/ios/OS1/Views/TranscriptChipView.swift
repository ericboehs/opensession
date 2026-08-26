import SwiftStreamingMarkdown
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#endif
#if os(macOS)
import AppKit
#endif

/// Draws the transcript's inline chips.
///
/// `TranscriptChip` explains why a chip is a text ATTACHMENT rather than
/// styled text: the markdown renderer paints every inline link in one colour,
/// and a chip needs its own wash, its own glyph and — for a pull request — its
/// own state colour. An attachment is the one inline thing the renderer hands
/// off, through `NSTextAttachmentViewProvider`, and this is that provider.
///
/// The view is drawn rather than composed: it is a rounded rect, a symbol and
/// a line of text, and one `draw` is cheaper than three subviews in a text
/// view that a lazily-built transcript throws away and rebuilds constantly.
final class TranscriptChipViewProvider: NSTextAttachmentViewProvider {
    private let chip: TranscriptChip.Rendered?

    #if os(iOS)
    required override init(
        textAttachment: NSTextAttachment,
        parentView: UIView?,
        textLayoutManager: NSTextLayoutManager?,
        location: any NSTextLocation
    ) {
        chip = textAttachment.contents.flatMap(TranscriptChip.rendered(payload:))
        super.init(
            textAttachment: textAttachment,
            parentView: parentView,
            textLayoutManager: textLayoutManager,
            location: location
        )
        // The line's layout comes from the VIEW's bounds, so the view has to
        // know its size before anything asks — which is why `loadView` sizes
        // it rather than waiting for `attachmentBounds`. With this off, the
        // layout fell back to the plain pill image the library rasterized
        // while parsing: the chip drew at one width and the line reserved
        // another, so every label was cut off inside a correctly-sized pill.
        tracksTextAttachmentViewBounds = true
    }
    #else
    required override init(
        textAttachment: NSTextAttachment,
        parentView: NSView?,
        textLayoutManager: NSTextLayoutManager?,
        location: any NSTextLocation
    ) {
        chip = textAttachment.contents.flatMap(TranscriptChip.rendered(payload:))
        super.init(
            textAttachment: textAttachment,
            parentView: parentView,
            textLayoutManager: textLayoutManager,
            location: location
        )
        // See the iOS branch: the layout reads the view's own bounds.
        tracksTextAttachmentViewBounds = true
    }
    #endif

    override func loadView() {
        guard let chip else {
            view = TranscriptChipView(frame: .zero)
            return
        }
        let chipView = TranscriptChipView(chip: chip)
        // Sized here, against the transcript's own body font, because the
        // layout asks the view how big it is before it hands over the font of
        // the line it landed in. `attachmentBounds` refines this the moment
        // that font and the container's width are known.
        _ = chipView.prepare(font: TranscriptChipView.bodyFont, maxWidth: ChipMetrics.maxWidth)
        view = chipView
    }

    /// Where the chip sits on the line, and how big it is.
    ///
    /// Both answers need the surrounding font, which only arrives here — so
    /// this is also where the view learns what size to draw at.
    ///
    /// The chip hangs from its own LABEL's baseline, so that the words inside
    /// the pill and the words beside it are set on one line — the only
    /// alignment the eye reads a chip inside a sentence by, and the one the
    /// web chips get from a zero-width text run at the head of the pill.
    /// Centring the pill instead, on the line's x-height band as this did,
    /// left every label a measured 5pt below the sentence it sat in: the
    /// label is centred in the pill against its full line box, and a line box
    /// carries descender room the ink never fills, so centring boxes cannot
    /// line up ink.
    ///
    /// Two terms, and the second is not a fudge. `baselineFromBottom` is
    /// where the label's baseline sits inside the pill. `font.descender` is
    /// there because the rect this returns is NOT measured from the baseline,
    /// whatever the coordinate space is called: the layout honours a change
    /// in `y` one for one, but from an origin one descender below the
    /// baseline. Measured on the simulator against a line of text with no
    /// descenders in it — without the term the label lands 4.3pt low against
    /// a 4.1pt descender, with it the two baselines agree to 0.0pt at every
    /// pill on the screen — and no other quantity the layout offers is near
    /// that number (the line fragment's own bottom is 6.9pt down).
    override func attachmentBounds(
        for attributes: [NSAttributedString.Key: Any],
        location: any NSTextLocation,
        textContainer: NSTextContainer?,
        proposedLineFragment: CGRect,
        position: CGPoint
    ) -> CGRect {
        guard let chipView = view as? TranscriptChipView else { return .zero }
        let font = attributes[.font] as? ChipFont ?? TranscriptChipView.bodyFont
        // A chip may not push the paragraph wider than it is: the label
        // ellipsizes instead. The cap is the CONTAINER's width, not the room
        // left on this line — a chip that doesn't fit here wraps to the next
        // one, and measuring it against the gap it happens to have landed in
        // truncated whole titles down to two words and a number down to its
        // ellipsis. Zero shows up while the container is still being sized.
        let container = textContainer?.size.width ?? proposedLineFragment.width
        let available = container > 1 ? min(container, ChipMetrics.maxWidth) : ChipMetrics.maxWidth
        let size = chipView.prepare(font: font, maxWidth: available)
        return CGRect(
            x: 0,
            y: -chipView.baselineFromBottom - font.descender,
            width: size.width,
            height: size.height
        )
    }

    /// Claims the file type the library gives inline citations, which is how
    /// this app's chips reach a view of their own. Idempotent, and called from
    /// the render config so it always happens before a chip can be laid out.
    ///
    /// The registry is UIKit's, and the library registers its own LaTeX
    /// provider from the text view's setup on the main thread; a render config
    /// is normally built there too, but it is a `static let` and nothing
    /// promises which thread touches it first.
    static func registerIfNeeded() {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { registerIfNeeded() }
            return
        }
        let type = UTType.url.identifier
        guard NSTextAttachment.textAttachmentViewProviderClass(forFileType: type) == nil else {
            return
        }
        NSTextAttachment.registerViewProviderClass(TranscriptChipViewProvider.self, forFileType: type)
    }
}

// MARK: - Metrics

private enum ChipMetrics {
    /// The web's chip is 0.95em against the body, and the same fraction reads
    /// right here: enough to sit inside the sentence rather than on top of it.
    static let fontScale: CGFloat = 0.95
    static let fallbackFontSize: CGFloat = 15
    static let radius: CGFloat = 7
    /// The scratch-file chip is the one with a rounder corner on the web,
    /// because its accent wash makes a sharper one read as a button.
    static let assetRadius: CGFloat = 9
    static let leading: CGFloat = 5
    static let trailing: CGFloat = 8
    static let iconGap: CGFloat = 4
    static let verticalPadding: CGFloat = 2
    static let iconScale: CGFloat = 1.05
    /// The widest a chip may be before its label ellipsizes. The real limit is
    /// the container it sits in, which `attachmentBounds` applies; this is
    /// only the ceiling for the first sizing pass, before the layout has said
    /// how wide the paragraph is. Wide enough for the longest title a chip is
    /// given (38 characters) at the largest body size, so a phone-width
    /// container is what decides, not this.
    static let maxWidth: CGFloat = 460
}

#if os(iOS)
typealias ChipFont = UIFont
typealias ChipColor = UIColor
typealias ChipViewBase = UIView
#else
typealias ChipFont = NSFont
typealias ChipColor = NSColor
typealias ChipViewBase = NSView
#endif

// MARK: - The chip itself

final class TranscriptChipView: ChipViewBase {
    /// The size the transcript's own prose is set at (`MarkdownRenderConfig`
    /// in MarkdownBody: the library's 17pt body on iOS, 13pt on the Mac). A
    /// chip is sized against this until the layout says otherwise, and on iOS
    /// it follows Dynamic Type the same way the paragraph around it does.
    static var bodyFont: ChipFont {
        #if os(iOS)
        return UIFont.systemFont(ofSize: UIFontMetrics.default.scaledValue(for: 17))
        #else
        return NSFont.systemFont(ofSize: 13)
        #endif
    }

    private var chip: TranscriptChip.Rendered?
    private var font: ChipFont = .systemFont(ofSize: ChipMetrics.fallbackFontSize)
    private var maxWidth: CGFloat = .greatestFiniteMagnitude
    private var measured: CGSize = .zero
    /// Where the label's top edge sits inside the pill. Measured once per
    /// sizing pass because the sizing and the drawing have to agree about it:
    /// it is what puts the baseline where the attachment promised the layout
    /// it would be.
    private var labelTop: CGFloat = 0

    init(chip: TranscriptChip.Rendered) {
        self.chip = chip
        super.init(frame: .zero)
        setUp()
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        setUp()
    }

    required init?(coder: NSCoder) { return nil }

    private func setUp() {
        #if os(iOS)
        backgroundColor = .clear
        isOpaque = false
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
        addGestureRecognizer(tap)
        isAccessibilityElement = true
        accessibilityTraits = .link
        accessibilityLabel = chip?.accessibilityLabel
        #else
        wantsLayer = true
        layer?.backgroundColor = ChipColor.clear.cgColor
        setAccessibilityElement(true)
        setAccessibilityRole(.link)
        setAccessibilityLabel(chip?.accessibilityLabel)
        #endif
    }

    #if os(macOS)
    override var isFlipped: Bool { true }
    #endif

    /// Sizes the chip against the font of the line it landed in. Returns the
    /// size the attachment should claim.
    func prepare(font: ChipFont, maxWidth: CGFloat) -> CGSize {
        guard chip != nil else { return .zero }
        let scaled = ChipFont.systemFont(
            ofSize: (font.pointSize * ChipMetrics.fontScale).rounded(),
            weight: chip?.kind == .pullRequest ? .semibold : .regular
        )
        guard scaled != self.font || maxWidth != self.maxWidth || measured == .zero else {
            return measured
        }
        self.font = scaled
        self.maxWidth = maxWidth
        measured = measure()
        // The layout sets the view's frame from what `attachmentBounds`
        // returns, but the first draw can land before that: paint against the
        // size just measured rather than an empty box.
        frame = CGRect(origin: frame.origin, size: measured)
        invalidateIntrinsicContentSize()
        redraw()
        return measured
    }

    override var intrinsicContentSize: CGSize { measured }

    /// The label's baseline, measured up from the chip's bottom edge. This is
    /// what the attachment hangs the pill from, so that the line's baseline
    /// and the label's are the same line — see `attachmentBounds`.
    var baselineFromBottom: CGFloat {
        max(measured.height - labelTop - font.ascender, 0)
    }

    private func measure() -> CGSize {
        let iconSide = (font.pointSize * ChipMetrics.iconScale).rounded()
        let chrome = ChipMetrics.leading + iconSide + ChipMetrics.iconGap + ChipMetrics.trailing
        let text = label.size()
        let height = (max(text.height, iconSide) + ChipMetrics.verticalPadding * 2).rounded(.up)
        let width = min((chrome + text.width).rounded(.up), maxWidth)
        labelTop = ((height - text.height) / 2).rounded()
        return CGSize(width: width, height: height)
    }

    // MARK: - Drawing

    override func draw(_ dirtyRect: CGRect) {
        guard chip != nil else { return }
        // The frame the layout gave this view is the chip: drawing against
        // anything else is how a chip ends up painted over its own sentence.
        let bounds = CGRect(origin: .zero, size: self.bounds.size)
        let palette = self.palette
        let radius = chip?.kind == .asset ? ChipMetrics.assetRadius : ChipMetrics.radius

        let path = ChipPath(roundedRect: bounds, cornerRadius: radius)
        palette.fill.setFill()
        path.fill()
        // Nothing may escape the pill. Attributed-string drawing lays text out
        // in the rect it is given but does not clip to it, so a label a pixel
        // too long for its chip printed straight over the next word.
        path.addClip()

        let iconSide = (font.pointSize * ChipMetrics.iconScale).rounded()
        let iconRect = CGRect(
            x: ChipMetrics.leading,
            y: ((bounds.height - iconSide) / 2).rounded(),
            width: iconSide,
            height: iconSide
        )
        icon(side: iconSide, color: palette.icon)?.draw(in: iconRect)

        // `labelTop`, not a fresh calculation against these bounds: the
        // attachment already told the layout where this label's baseline
        // would fall, and drawing it anywhere else makes that a lie.
        let textOrigin = CGPoint(
            x: iconRect.maxX + ChipMetrics.iconGap,
            y: labelTop
        )
        let textWidth = max(bounds.width - textOrigin.x - ChipMetrics.trailing, 0)
        label.draw(
            with: CGRect(origin: textOrigin, size: CGSize(width: textWidth, height: bounds.height)),
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            context: nil
        )
    }

    /// The label, ready to measure or draw. Truncates in the middle of nothing:
    /// the titles that reach here are already shortened by whoever built the
    /// chip, and this is only the guard for a narrow phone.
    private var label: NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        return NSAttributedString(
            string: chip?.title ?? "",
            attributes: [
                .font: font,
                .foregroundColor: palette.label,
                .paragraphStyle: paragraph,
            ]
        )
    }

    private func icon(side: CGFloat, color: ChipColor) -> ChipImage? {
        guard let name = chip?.kind.symbolName else { return nil }
        #if os(iOS)
        let config = UIImage.SymbolConfiguration(pointSize: side * 0.78, weight: .medium)
        return UIImage(systemName: name, withConfiguration: config)?
            .withTintColor(color, renderingMode: .alwaysOriginal)
        #else
        let config = NSImage.SymbolConfiguration(pointSize: side * 0.78, weight: .medium)
            .applying(NSImage.SymbolConfiguration(paletteColors: [color]))
        return NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(config)
        #endif
    }

    // MARK: - Colour

    private struct Palette {
        var fill: ChipColor
        var label: ChipColor
        var icon: ChipColor
    }

    private var palette: Palette {
        let tone = chip?.tone ?? .neutral
        switch tone {
        case .neutral:
            return Palette(
                fill: ChipColor(OS1VisualStyle.hover),
                label: ChipColor(OS1VisualStyle.text),
                icon: ChipColor(OS1VisualStyle.textDim)
            )
        case .accent:
            return Palette(
                fill: ChipColor(OS1VisualStyle.accent).withAlphaComponent(Self.washAlpha),
                label: ChipColor(OS1VisualStyle.text),
                icon: ChipColor(OS1VisualStyle.accentInk)
            )
        case .gray:
            return Palette(
                fill: ChipColor(OS1VisualStyle.hover),
                label: ChipColor(OS1VisualStyle.textDim),
                icon: ChipColor(OS1VisualStyle.textDim)
            )
        case .green:
            return tinted(OS1VisualStyle.green, ink: Self.ink(dark: (0.247, 0.725, 0.314), light: (0.102, 0.498, 0.216)))
        case .yellow:
            return tinted(OS1VisualStyle.yellow, ink: Self.ink(dark: (0.824, 0.600, 0.133), light: (0.561, 0.373, 0.0)))
        case .red:
            return tinted(OS1VisualStyle.red, ink: Self.ink(dark: (0.973, 0.318, 0.286), light: (0.812, 0.133, 0.180)))
        case .purple:
            return tinted(OS1VisualStyle.purple, ink: Self.ink(dark: (0.639, 0.443, 0.969), light: (0.510, 0.314, 0.875)))
        }
    }

    /// A status wash is the status colour thinned; the words on it are a
    /// darker version of the same status in light appearance.
    ///
    /// `OS1VisualStyle`'s five status colours are one pair of values for both
    /// appearances, and those values are the web's DARK theme. As a wash they
    /// are fine — a wash is seen rather than read — but the chip's own label
    /// sits ON that wash and measures about 2.5:1 against a light transcript,
    /// under even the 3:1 that large text gets. Light therefore takes the
    /// web's light-theme value for each status (`--green` and friends under
    /// `html[data-theme="light"]` in base.css), except yellow, which is one
    /// step darker because the transcript canvas sits below white.
    private func tinted(_ fill: Color, ink: ChipColor) -> Palette {
        Palette(
            fill: ChipColor(fill).withAlphaComponent(Self.washAlpha),
            label: ink,
            icon: ink
        )
    }

    private static func ink(
        dark: (CGFloat, CGFloat, CGFloat),
        light: (CGFloat, CGFloat, CGFloat)
    ) -> ChipColor {
        #if os(iOS)
        return UIColor { traits in
            let rgb = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1)
        }
        #else
        return NSColor(name: nil) { appearance in
            let rgb = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(red: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1)
        }
        #endif
    }

    private static let washAlpha: CGFloat = 0.14

    // MARK: - Tap

    /// Opening the chip is the paragraph's job, not this view's: the renderer
    /// hands every URL to whoever is showing the transcript, and a chip has to
    /// land in the same place a plain link would. So the tap is routed back
    /// through the enclosing text view's delegate, with the same URL the
    /// library would have sent had it drawn the attachment itself.
    #if os(iOS)
    @objc private func handleTap() {
        guard let url = chip?.url, let textView = enclosingTextView else { return }
        flash()
        _ = textView.delegate?.textView?(
            textView,
            shouldInteractWith: url,
            in: NSRange(location: 0, length: 1),
            interaction: .invokeDefaultAction
        )
    }

    private var enclosingTextView: UITextView? {
        var next = superview
        while let view = next {
            if let textView = view as? UITextView { return textView }
            next = view.superview
        }
        return nil
    }

    /// The press the web gets from `:active`. A chip is a small target inside
    /// a paragraph, so the confirmation that it took the tap matters more here
    /// than the animation does.
    private func flash() {
        alpha = 0.55
        UIView.animate(withDuration: 0.18) { self.alpha = 1 }
    }
    #else
    override func mouseDown(with event: NSEvent) {
        guard let url = chip?.url, let textView = enclosingTextView else {
            super.mouseDown(with: event)
            return
        }
        textView.clicked(onLink: url, at: 0)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    private var enclosingTextView: NSTextView? {
        var next = superview
        while let view = next {
            if let textView = view as? NSTextView { return textView }
            next = view.superview
        }
        return nil
    }
    #endif

    private func redraw() {
        #if os(iOS)
        setNeedsDisplay()
        #else
        needsDisplay = true
        #endif
    }

    #if os(iOS)
    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        if traitCollection.userInterfaceStyle != previous?.userInterfaceStyle { redraw() }
    }
    #else
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        redraw()
    }
    #endif
}

extension MarkdownRenderConfig.CitationConfig {
    /// What turns a chip's markdown into an attachment at all.
    ///
    /// The colours and the font here are the FALLBACK, not the chip: the
    /// library rasterizes a plain pill from them while parsing, and
    /// `TranscriptChipViewProvider` draws over it. They are real values rather
    /// than placeholders so that a build where the provider never registers
    /// still shows a legible chip instead of a stub.
    static let os1Chips = MarkdownRenderConfig.CitationConfig(
        coder: TranscriptChip.coder,
        font: .systemFont(ofSize: ChipMetrics.fallbackFontSize * ChipMetrics.fontScale),
        textColor: OS1VisualStyle.text,
        backgroundColor: OS1VisualStyle.hover
    )
}

private extension TranscriptChip.Kind {
    /// The glyph, named the way the web names it: what OPENS when you follow
    /// the chip. A conversation, a routine, a document, a branch.
    var symbolName: String {
        switch self {
        case .session: "bubble.left"
        case .automation: "clock.arrow.circlepath"
        case .asset: "doc.text"
        case .pullRequest: "arrow.triangle.branch"
        }
    }
}

#if os(iOS)
typealias ChipImage = UIImage
typealias ChipPath = UIBezierPath
#else
typealias ChipImage = NSImage
typealias ChipPath = NSBezierPath

private extension NSBezierPath {
    convenience init(roundedRect rect: CGRect, cornerRadius: CGFloat) {
        self.init(roundedRect: rect, xRadius: cornerRadius, yRadius: cornerRadius)
    }
}
#endif
