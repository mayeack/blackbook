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
