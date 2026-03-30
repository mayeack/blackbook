import SwiftUI
import SwiftData

struct BackupRestoreView: View {
    @Environment(\.modelContext) private var modelContext
    @State private var backupService = BackupService()
    @State private var selectedBackup: BackupMetadata?
    @AppStorage(AppConstants.Backup.autoBackupEnabledKey) private var autoBackupEnabled = true
    @AppStorage(AppConstants.Backup.maxBackupsKey) private var maxBackups = AppConstants.Backup.maxBackupsDefault

    var body: some View {
        Form {
            statusSection
            actionsSection
            backupsListSection
            settingsSection
        }
        .formStyle(.grouped)
        .navigationTitle("Backup & Restore")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear {
            backupService.loadBackups()
        }
        .sheet(item: $selectedBackup) { backup in
            NavigationStack {
                BackupDetailView(backup: backup, backupService: backupService)
            }
        }
    }

    // MARK: - Status

    private var statusSection: some View {
        Section {
            SettingsRow(
                icon: "clock.fill",
                iconColor: .blue,
                title: "Last Backup",
                subtitle: nil
            ) {
                Text(backupService.backups.first?.relativeDate ?? "Never")
                    .foregroundStyle(.secondary)
            }

            SettingsRow(
                icon: "internaldrive.fill",
                iconColor: .gray,
                title: "Storage Used",
                subtitle: nil
            ) {
                Text("\(backupService.formattedTotalSize) (\(backupService.backups.count) backups)")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Status")
        }
    }

    // MARK: - Actions

    private var actionsSection: some View {
        Section {
            Button {
                Task {
                    await backupService.createBackup(modelContext: modelContext, type: .manual)
                }
            } label: {
                SettingsRow(
                    icon: "plus.circle.fill",
                    iconColor: .green,
                    title: "Create Backup Now",
                    subtitle: nil
                ) {
                    if backupService.isCreatingBackup {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(backupService.isCreatingBackup)

            if let error = backupService.lastError {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.caption)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                .padding(.leading, 40)
            }
        }
    }

    // MARK: - Backups List

    private var backupsListSection: some View {
        Section {
            if backupService.backups.isEmpty {
                ContentUnavailableView {
                    Label("No Backups", systemImage: "clock.arrow.circlepath")
                } description: {
                    Text("Create a backup to protect your data.")
                }
            } else {
                ForEach(backupService.backups) { backup in
                    Button {
                        selectedBackup = backup
                    } label: {
                        backupRow(backup)
                    }
                    .buttonStyle(.plain)
                }
                .onDelete { indexSet in
                    for index in indexSet {
                        backupService.deleteBackup(backupService.backups[index])
                    }
                }
            }
        } header: {
            Text("Available Backups")
        }
    }

    private func backupRow(_ backup: BackupMetadata) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(backup.formattedDate)
                        .font(.subheadline.weight(.medium))
                    typeBadge(backup.type)
                }
                Text("\(backup.totalRecords) records \u{00B7} \(backup.formattedSize)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }

    private func typeBadge(_ type: BackupType) -> some View {
        Text(type.displayName)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(badgeColor(for: type).opacity(0.15), in: Capsule())
            .foregroundStyle(badgeColor(for: type))
    }

    private func badgeColor(for type: BackupType) -> Color {
        switch type {
        case .manual: .blue
        case .automatic: .green
        case .preRestore: .orange
        }
    }

    // MARK: - Settings

    private var settingsSection: some View {
        Section {
            Toggle(isOn: $autoBackupEnabled) {
                SettingsRow(
                    icon: "arrow.triangle.2.circlepath",
                    iconColor: .teal,
                    title: "Daily Automatic Backup",
                    subtitle: nil
                ) {
                    EmptyView()
                }
            }

            Stepper(value: $maxBackups, in: 3...20) {
                SettingsRow(
                    icon: "tray.2.fill",
                    iconColor: .indigo,
                    title: "Keep Last",
                    subtitle: nil
                ) {
                    Text("\(maxBackups) backups")
                        .foregroundStyle(.secondary)
                }
            }
            .onChange(of: maxBackups) {
                backupService.pruneOldBackups()
            }
        } header: {
            Text("Settings")
        }
    }
}
