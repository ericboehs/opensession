import SwiftUI

/// Non-image composer attachments. A file opens into the composer as a named
/// chip immediately, then stages in place. A failed upload stays visible and
/// tappable to retry instead of disappearing after the Files app handed it off.
struct AttachedFilesRow: View {
    let files: [AttachedFile]
    let staging: Set<String>
    let failed: Set<String>
    let onRetry: (AttachedFile) -> Void
    let onRemove: (AttachedFile) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(files) { file in
                    HStack(spacing: 0) {
                        status(file)
                        Button {
                            onRemove(file)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(OS1VisualStyle.textDim)
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(file.name)")
                    }
                    .background(.fill.tertiary, in: RoundedRectangle(
                        cornerRadius: 10, style: .continuous
                    ))
                }
            }
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder
    private func status(_ file: AttachedFile) -> some View {
        let content = HStack(spacing: 8) {
            if staging.contains(file.id) {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: failed.contains(file.id)
                      ? "arrow.clockwise"
                      : "text.document")
                    .font(.callout)
                    .foregroundStyle(
                        failed.contains(file.id)
                            ? OS1VisualStyle.red
                            : OS1VisualStyle.textDim
                    )
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(file.name)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.text)
                    .lineLimit(1)
                if failed.contains(file.id) {
                    Text("Tap to retry")
                        .font(.caption2)
                        .foregroundStyle(OS1VisualStyle.red)
                }
            }
        }
        .padding(.leading, 12)
        .frame(minWidth: 112, maxWidth: 240, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())

        if failed.contains(file.id) {
            Button { onRetry(file) } label: { content }
                .buttonStyle(.plain)
                .accessibilityLabel("Retry attaching \(file.name)")
        } else {
            content
        }
    }
}
