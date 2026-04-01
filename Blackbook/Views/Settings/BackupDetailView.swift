import SwiftUI
import SwiftData

struct BackupDetailView: View {
    let backup: BackupMetadata
    @Bindable var backupService: BackupService
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @State private var showRestoreConfirm = false
    @State private var showDeleteConfirm = false
    @State private var showRestoreProgress = false

    var body: some View {
        Form {
            detailsSection
            recordCountsSection
            restoreSection
            deleteSection
        }
        .formStyle(.grouped)
        .navigationTitle("Backup Details")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { dismiss() }
            }
        }
        .alert("Restore Backup", isPresented: $showRestoreConfirm) {
            Button("Restore", role: .destructive) {
                performRestore()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will replace all current data with the backup from \(backup.formattedDate). A safety backup of your current data will be created first. The app will close and reopen with the restored data.")
        }
        .alert("Delete Backup", isPresented: $showDeleteConfirm) {
            Button("Delete", role: .destructive) {
                if backup.source == .remote {
                    Task {
                        await backupService.deleteRemoteBackup(backup)
                        dismiss()
                    }
                } else {
                    backupService.deleteBackup(backup)
                    dismiss()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(backup.source == .remote
                 ? "This backup will be permanently deleted from the server. This action cannot be undone."
                 : "This backup will be permanently deleted. This action cannot be undone.")
        }
    }

    // MARK: - Details

    private var detailsSection: some View {
        Section {
            LabeledContent("Date") {
                Text(backup.formattedDate)
            }
            LabeledContent("Type") {
                Text(backup.type.displayName)
            }
            if let deviceName = backup.deviceName {
                LabeledContent("Device") {
                    Text(deviceName)
                }
            }
            if backup.source == .remote {
                LabeledContent("Location") {
                    HStack(spacing: 4) {
                        Image(systemName: "externaldrive.fill")
                            .font(.caption)
                        Text("Server")
                    }
                    .foregroundStyle(.teal)
                }
            }
            if let label = backup.label {
                LabeledContent("Label") {
                    Text(label)
                }
            }
            LabeledContent("App Version") {
                Text(backup.appVersion)
            }
            LabeledContent("Size") {
                Text(backup.formattedSize)
            }
            LabeledContent("Total Records") {
                Text("\(backup.totalRecords)")
            }
        } header: {
            Text("Details")
        }
    }

    // MARK: - Record Counts

    private var recordCountsSection: some View {
        Section {
            let sortedCounts = backup.recordCounts.sorted { $0.key < $1.key }
            ForEach(sortedCounts, id: \.key) { key, value in
                LabeledContent(key) {
                    Text("\(value)")
                        .monospacedDigit()
                }
            }
        } header: {
            Text("Records")
        }
    }

    // MARK: - Restore

    private var restoreSection: some View {
        Section {
            Button {
                showRestoreConfirm = true
            } label: {
                HStack {
                    Spacer()
                    if showRestoreProgress || backupService.isDownloadingBackup {
                        ProgressView()
                            .controlSize(.small)
                            .padding(.trailing, 8)
                        if backupService.isDownloadingBackup {
                            Text("Downloading... \(Int(backupService.downloadProgress * 100))%")
                        } else {
                            Text("Preparing restore...")
                        }
                    } else {
                        Image(systemName: backup.source == .remote ? "arrow.down.circle" : "arrow.counterclockwise")
                        Text(backup.source == .remote ? "Download & Restore" : "Restore This Backup")
                    }
                    Spacer()
                }
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.vertical, 8)
            }
            .listRowBackground(Color.blue)
            .disabled(showRestoreProgress || backupService.isPreparingRestore || backupService.isDownloadingBackup)
        } footer: {
            if backup.source == .remote {
                Text("This backup will be downloaded from the server first, then restored. A safety backup of your current data will be created automatically. The app will close and restart with the restored data.")
            } else {
                Text("A safety backup of your current data will be created automatically before restoring. The app will close and restart with the restored data.")
            }
        }
    }

    // MARK: - Delete

    private var deleteSection: some View {
        Section {
            Button(role: .destructive) {
                showDeleteConfirm = true
            } label: {
                HStack {
                    Spacer()
                    Text(backup.source == .remote ? "Delete from Server" : "Delete Backup")
                    Spacer()
                }
            }
        }
    }

    // MARK: - Actions

    private func performRestore() {
        showRestoreProgress = true
        Task {
            var localBackup = backup

            // If remote, download first
            if backup.source == .remote {
                let downloaded = await backupService.downloadBackupFromServer(metadata: backup)
                guard downloaded else {
                    showRestoreProgress = false
                    return
                }
                localBackup.source = .local
            }

            let success = await backupService.prepareRestore(from: localBackup, modelContext: modelContext)
            if success {
                try? await Task.sleep(for: .milliseconds(500))
                exit(0)
            } else {
                showRestoreProgress = false
            }
        }
    }
}
