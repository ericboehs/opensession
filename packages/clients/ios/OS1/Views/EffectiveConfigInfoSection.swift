import SwiftUI

#if os(iOS)
struct EffectiveConfigInfoContent: View {
    @Bindable var model: EffectiveConfigViewModel
    let retry: () -> Void

    var body: some View {
        if model.isLoading && model.config == nil {
            HStack(spacing: 9) {
                ProgressView().controlSize(.small)
                Text("Resolving the next turn…")
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        } else if let error = model.error, model.config == nil {
            VStack(alignment: .leading, spacing: 8) {
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.textDim)
                Button("Try again", action: retry)
                    .font(.subheadline.weight(.medium))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        } else if model.config != nil {
            if let error = model.error {
                Text("Couldn't refresh: \(error)")
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.yellow)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                Divider()
            }
            configGroup("Model and account", rows: model.modelRows)
            Divider()
            configGroup("MCP", rows: model.mcpRows)
            Divider()
            configGroup("Instructions", rows: model.instructionRows)
            Divider()
            configGroup("Permissions", rows: model.permissionRows)
            if let caveat = model.config?.caveat, !caveat.isEmpty {
                Divider()
                Text(caveat)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .padding(12)
            }
        }
    }

    private func configGroup(_ title: String, rows: [EffectiveConfigViewModel.DisplayRow]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textDim)
                .padding(.horizontal, 12)
                .padding(.top, 11)
                .padding(.bottom, 3)
            ForEach(rows) { row in
                configRow(row)
            }
        }
    }

    private func configRow(_ row: EffectiveConfigViewModel.DisplayRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.label)
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.textDim)
                Spacer(minLength: 12)
                if row.forecast {
                    Text("Forecast")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(OS1VisualStyle.blue)
                }
            }
            ForEach(Array(row.values.enumerated()), id: \.offset) { _, value in
                Text(value)
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.text)
                    .textSelection(.enabled)
            }
            Text(row.source)
                .font(.caption2)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .textSelection(.enabled)
            if let note = row.note, !note.isEmpty {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}
#endif
