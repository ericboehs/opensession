import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// One ```mermaid fence in a transcript message.
///
/// Shows the source as a code block first and swaps in the drawn diagram when
/// the renderer answers — so a message reads immediately, and a fence that
/// mermaid can't draw simply stays a code block forever, which is what the web
/// does with the same input.
///
/// The picture is a plain `Image`: tap it for the full-screen viewer, pinch it
/// where it sits, the same as every other image in the transcript.
struct MermaidDiagramView: View {
    let source: String

    @Environment(\.colorScheme) private var colorScheme
    @State private var diagram: MermaidDiagram?

    var body: some View {
        Group {
            if let diagram {
                drawn(diagram)
            } else {
                MermaidSourceBlock(source: source)
            }
        }
        .task(id: Request(source: source, dark: colorScheme == .dark)) {
            // Redrawn on a theme flip: mermaid bakes its ink into the SVG, so
            // a diagram rendered in dark mode is unreadable in light.
            diagram = nil
            diagram = await MermaidRenderer.shared.diagram(
                source: source,
                dark: colorScheme == .dark,
                background: Self.backgroundHex(dark: colorScheme == .dark)
            )
        }
    }

    private struct Request: Hashable {
        let source: String
        let dark: Bool
    }

    /// Natural size, shrunk to fit a narrow phone but never blown up past what
    /// mermaid laid out — an upscaled bitmap of a small diagram looks broken in
    /// a way the diagram itself is not.
    ///
    /// One flexible frame, and no `maxWidth: .infinity` around it: that
    /// proposes an UNBOUNDED width to the image, which then lays out at its
    /// natural size and gets clipped by the row instead of scaling into it.
    /// The `alignment` here is what keeps a narrow diagram against the left
    /// margin, which is what the second frame was reaching for.
    @ViewBuilder
    private func drawn(_ diagram: MermaidDiagram) -> some View {
        Image(platformImageData: diagram.png, scale: diagram.scale)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: diagram.size.width, alignment: .leading)
            .accessibilityLabel("Diagram")
            .modifier(DiagramInteractions(png: diagram.png))
    }

    /// The web view paints on this, and the row draws the same colour behind
    /// the finished bitmap, so the diagram sits in the code well it started in
    /// rather than on a transparent patch whose edges show at every zoom level.
    private static func backgroundHex(dark: Bool) -> String {
        #if os(iOS)
        let resolved = UIColor(OS1VisualStyle.markdownCodeWell).resolvedColor(
            with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        )
        #else
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        var resolved = NSColor(OS1VisualStyle.markdownCodeWell)
        appearance?.performAsCurrentDrawingAppearance {
            resolved = resolved.usingColorSpace(.sRGB) ?? resolved
        }
        #endif
        // The well is a translucent ink tint; the page underneath it is opaque,
        // so the two are composited here rather than shipped as an alpha.
        return resolved.blendedOverPage(dark: dark)
    }
}

/// Interactions that only exist on the phone: the Mac transcript has no
/// full-screen image viewer and no pinch-to-peek.
private struct DiagramInteractions: ViewModifier {
    let png: Data

    #if os(iOS)
    @State private var presented = false
    #endif

    func body(content: Content) -> some View {
        #if os(iOS)
        Button { presented = true } label: { content }
            .buttonStyle(.plain)
            .accessibilityHint("Shows the diagram full screen")
            .pinchToPeek(png, cornerRadius: 8)
            .fullScreenCover(isPresented: $presented) {
                FullScreenImagePreview(
                    items: [PreviewImage(id: "diagram", source: .data(png))],
                    index: 0
                )
            }
        #else
        content
        #endif
    }
}

/// The fence as written: what a diagram looks like before it is drawn, and for
/// good after mermaid rejects it.
private struct MermaidSourceBlock: View {
    let source: String

    var body: some View {
        SyntaxHighlightedCodeText(text: source, language: "plaintext")
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(OS1VisualStyle.markdownCodeWell)
            )
    }
}

private extension Image {
    /// One initialiser for both platforms' image types, at the scale the
    /// bitmap was captured at — PNG doesn't carry one, and the default of 1
    /// would make a Retina snapshot claim to be two or three times its size.
    init(platformImageData data: Data, scale: CGFloat) {
        #if os(iOS)
        self.init(uiImage: UIImage(data: data, scale: max(scale, 1)) ?? UIImage())
        #else
        let image = NSImage(data: data) ?? NSImage()
        if scale > 1, image.size.width > 0 {
            image.size = CGSize(
                width: image.size.width / scale,
                height: image.size.height / scale
            )
        }
        self.init(nsImage: image)
        #endif
    }
}

#if os(iOS)
private extension UIColor {
    /// This colour composited over the transcript's own background, as `#rrggbb`
    /// — a hex the web view can paint with, which an alpha-carrying tint is not.
    func blendedOverPage(dark: Bool) -> String {
        let page = UIColor(OS1VisualStyle.background).resolvedColor(
            with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        )
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        getRed(&r, green: &g, blue: &b, alpha: &a)
        var (pr, pg, pb, pa): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        page.getRed(&pr, green: &pg, blue: &pb, alpha: &pa)
        return MermaidHex.string(
            red: r * a + pr * (1 - a),
            green: g * a + pg * (1 - a),
            blue: b * a + pb * (1 - a)
        )
    }
}
#else
private extension NSColor {
    func blendedOverPage(dark: Bool) -> String {
        let page = (NSColor(OS1VisualStyle.background).usingColorSpace(.sRGB)
            ?? NSColor.windowBackgroundColor)
        guard let tint = usingColorSpace(.sRGB) else { return dark ? "#000000" : "#ffffff" }
        let a = tint.alphaComponent
        return MermaidHex.string(
            red: tint.redComponent * a + page.redComponent * (1 - a),
            green: tint.greenComponent * a + page.greenComponent * (1 - a),
            blue: tint.blueComponent * a + page.blueComponent * (1 - a)
        )
    }
}
#endif

private enum MermaidHex {
    static func string(red: CGFloat, green: CGFloat, blue: CGFloat) -> String {
        func channel(_ value: CGFloat) -> Int {
            Int((min(max(value, 0), 1) * 255).rounded())
        }
        return String(
            format: "#%02x%02x%02x",
            channel(red),
            channel(green),
            channel(blue)
        )
    }
}
