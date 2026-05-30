import SwiftUI

struct ServerMenuView: View {
    @Bindable var model: ServerStatusModel
    @State private var editingEmail = ""
    @State private var isEditingEmail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Status
            HStack(spacing: 8) {
                Circle()
                    .fill(model.isRunning ? .green : .red)
                    .frame(width: 10, height: 10)
                if model.isRunning {
                    Text("Running on port \(model.port)")
                        .font(.headline)
                } else if model.isConfigured {
                    Text("Stopped")
                        .font(.headline)
                } else {
                    Text("Not configured")
                        .font(.headline)
                }
            }

            Divider()

            // Email config
            if isEditingEmail || !model.isConfigured {
                HStack {
                    TextField("Email address", text: $editingEmail)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { saveEmail() }
                    Button("Save") { saveEmail() }
                        .disabled(editingEmail.isEmpty)
                }
            } else {
                HStack {
                    Label(model.email, systemImage: "envelope")
                        .font(.caption)
                        .lineLimit(1)
                    Spacer()
                    Button("Change") {
                        editingEmail = model.email
                        isEditingEmail = true
                    }
                    .font(.caption)
                }
            }

            if model.isConfigured {
                Divider()

                // Stats
                HStack {
                    Label("\(model.backupCount) backup\(model.backupCount == 1 ? "" : "s")", systemImage: "externaldrive")
                    Spacer()
                    Text(model.diskUsage)
                        .foregroundStyle(.secondary)
                }
                .font(.caption)

                Divider()

                // Controls
                if model.isRunning {
                    Button("Stop Server") {
                        model.stopServer()
                    }
                } else {
                    Button("Start Server") {
                        model.startServer()
                    }
                }

                Toggle("Launch at Login", isOn: Binding(
                    get: { model.launchAtLogin },
                    set: { model.launchAtLogin = $0 }
                ))
            }

            Divider()

            iMessageSection

            Divider()

            Button("Quit Blackbook Server") {
                NSApplication.shared.terminate(nil)
            }
        }
        .padding()
        .frame(width: 280)
        .onAppear {
            if !model.isConfigured {
                editingEmail = model.email
            }
            model.refreshStatus()
        }
    }

    @ViewBuilder
    private var iMessageSection: some View {
        let im = model.imessage
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(
                get: { im.isEnabled },
                set: { im.isEnabled = $0 }
            )) {
                Label("Log iMessages", systemImage: "message")
                    .font(.caption)
            }

            if im.isRunning {
                HStack {
                    Text("\(im.messagesProcessed) logged")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let date = im.lastSyncDate {
                        Spacer()
                        Text("checked \(date.formatted(.relative(presentation: .numeric)))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Button {
                    Task { await im.backfill(daysBack: 30) }
                } label: {
                    HStack(spacing: 6) {
                        if im.isBackfilling {
                            ProgressView().controlSize(.small)
                            Text("Importing…")
                        } else {
                            Image(systemName: "clock.arrow.circlepath")
                            Text("Sync Last 30 Days")
                        }
                    }
                    .font(.caption)
                }
                .disabled(im.isBackfilling)
            }

            if let err = im.syncError {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open Full Disk Access") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .font(.caption2)
            }

            if !im.unmatchedHandlesLastPoll.isEmpty {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(im.unmatchedHandlesLastPoll, id: \.self) { handle in
                            Text(handle)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        Text("Add as a phone or email on the matching contact to log their messages.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                } label: {
                    Text("Unmatched handles (\(im.unmatchedHandlesLastPoll.count))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func saveEmail() {
        let trimmed = editingEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        model.email = trimmed
        isEditingEmail = false
        if !model.isRunning {
            model.startServer()
        }
    }
}
