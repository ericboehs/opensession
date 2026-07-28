import SwiftUI

/// The same 24-point icon geometry used by the web client's iconic-pro set.
/// Keeping these paths shared in spirit avoids mismatched SF Symbol metaphors
/// for product-specific states such as pull requests and merges.
enum WebIconKind {
    case search
    case filter
    case pullRequest
    case gitMerge
    case archive
    case unarchive
}

struct WebIcon: View {
    let kind: WebIconKind
    var size: CGFloat = 22
    var color: Color = .primary

    var body: some View {
        Canvas { context, canvasSize in
            let scale = min(canvasSize.width, canvasSize.height) / 24
            let offset = CGPoint(
                x: (canvasSize.width - 24 * scale) / 2,
                y: (canvasSize.height - 24 * scale) / 2
            )
            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: offset.x + x * scale, y: offset.y + y * scale)
            }
            func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
                CGRect(
                    x: offset.x + x * scale,
                    y: offset.y + y * scale,
                    width: width * scale,
                    height: height * scale
                )
            }
            let stroke = StrokeStyle(
                lineWidth: 1.5 * scale,
                lineCap: .round,
                lineJoin: .round
            )

            switch kind {
            case .filter:
                var bars = Path()
                bars.addRoundedRect(in: rect(4, 6, 16, 1.5), cornerSize: CGSize(width: 0.75, height: 0.75))
                bars.addRoundedRect(in: rect(6, 11.25, 12, 1.5), cornerSize: CGSize(width: 0.75, height: 0.75))
                bars.addRoundedRect(in: rect(8, 16.5, 8, 1.5), cornerSize: CGSize(width: 0.75, height: 0.75))
                context.fill(bars, with: .color(color))
            default:
                var path = Path()
                switch kind {
                case .search:
                    path.addEllipse(in: rect(4.75, 4.75, 11.5, 11.5))
                    path.move(to: point(14.85, 14.85))
                    path.addLine(to: point(18.75, 18.75))
                case .pullRequest:
                    addCircle(to: &path, center: point(7, 6.5), radius: 1.75 * scale)
                    addCircle(to: &path, center: point(7, 17.5), radius: 1.75 * scale)
                    addCircle(to: &path, center: point(17, 17.5), radius: 1.75 * scale)
                    path.move(to: point(7, 8.25))
                    path.addLine(to: point(7, 15.75))
                    path.move(to: point(12.25, 6.5))
                    path.addLine(to: point(15, 6.5))
                    path.addCurve(
                        to: point(17, 8.5),
                        control1: point(16.105, 6.5),
                        control2: point(17, 7.395)
                    )
                    path.addLine(to: point(17, 15.75))
                case .gitMerge:
                    addCircle(to: &path, center: point(7, 6.5), radius: 1.75 * scale)
                    addCircle(to: &path, center: point(7, 17.5), radius: 1.75 * scale)
                    addCircle(to: &path, center: point(17, 13), radius: 1.75 * scale)
                    path.move(to: point(7, 8.25))
                    path.addLine(to: point(7, 15.75))
                    path.move(to: point(7, 9))
                    path.addCurve(
                        to: point(15.25, 13),
                        control1: point(7, 11.5),
                        control2: point(10, 13)
                    )
                case .archive:
                    path.addRoundedRect(
                        in: rect(4, 4.75, 16, 4),
                        cornerSize: CGSize(width: scale, height: scale)
                    )
                    path.move(to: point(5.5, 8.75))
                    path.addLine(to: point(5.5, 17.25))
                    path.addCurve(
                        to: point(7.5, 19.25),
                        control1: point(5.5, 18.355),
                        control2: point(6.395, 19.25)
                    )
                    path.addLine(to: point(16.5, 19.25))
                    path.addCurve(
                        to: point(18.5, 17.25),
                        control1: point(17.605, 19.25),
                        control2: point(18.5, 18.355)
                    )
                    path.addLine(to: point(18.5, 8.75))
                    path.move(to: point(10, 12.25))
                    path.addLine(to: point(14, 12.25))
                case .unarchive:
                    path.addRoundedRect(
                        in: rect(4, 4.75, 16, 4),
                        cornerSize: CGSize(width: scale, height: scale)
                    )
                    path.move(to: point(5.5, 8.75))
                    path.addLine(to: point(5.5, 17.25))
                    path.addCurve(
                        to: point(7.5, 19.25),
                        control1: point(5.5, 18.355),
                        control2: point(6.395, 19.25)
                    )
                    path.addLine(to: point(16.5, 19.25))
                    path.addCurve(
                        to: point(18.5, 17.25),
                        control1: point(17.605, 19.25),
                        control2: point(18.5, 18.355)
                    )
                    path.addLine(to: point(18.5, 8.75))
                    path.move(to: point(12, 16.25))
                    path.addLine(to: point(12, 11.75))
                    path.move(to: point(9.75, 14))
                    path.addLine(to: point(12, 11.75))
                    path.addLine(to: point(14.25, 14))
                case .filter:
                    break
                }
                context.stroke(path, with: .color(color), style: stroke)
            }
        }
        .frame(width: size, height: size)
    }

    private func addCircle(to path: inout Path, center: CGPoint, radius: CGFloat) {
        path.addEllipse(
            in: CGRect(
                x: center.x - radius,
                y: center.y - radius,
                width: radius * 2,
                height: radius * 2
            )
        )
    }
}
