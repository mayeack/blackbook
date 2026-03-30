import SwiftUI
import SwiftData

// MARK: - Settings Row Icon

struct SettingsIcon: View {
    let systemName: String
    let color: Color

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(color, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

// MARK: - Settings Row

struct SettingsRow<Trailing: View>: View {
    let icon: String
    let iconColor: Color
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            SettingsIcon(systemName: icon, color: iconColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            trailing()
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Main Settings View

struct SettingsView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(AuthenticationService.self) private var authService
    @State private var syncService = ContactSyncService()
    @State private var showAPIKeyEntry = false
    @State private var hasAPIKey = false
    @State private var calendarService = GoogleCalendarService()
    @State private var showGoogleClientIdEntry = false
    @State private var showSignOutConfirm = false
    #if os(macOS)
    @Environment(IMessageSyncService.self) private var iMessageService
    #endif

    var body: some View {
        NavigationStack {
            Form {
                contactsSyncSection
                #if os(macOS)
                iMessageSyncSection
                #endif
                hiddenContactsSection
                securitySection
                dataSection
                aiSection
                googleCalendarSection
                scoringSection
                subscriptionSection
                accountSection
                aboutSection
            }
            .formStyle(.grouped)
            .navigationTitle("Settings")
            .sheet(isPresented: $showAPIKeyEntry) {
                APIKeyEntryView(onSave: { hasAPIKey = true })
            }
            .sheet(isPresented: $showGoogleClientIdEntry) {
                GoogleClientIdEntryView(calendarService: calendarService)
            }
            .alert("Sign out of \(authService.displayName ?? "account")?", isPresented: $showSignOutConfirm) {
                Button("Sign Out", role: .destructive) {
                    Task { await authService.signOut() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Are you sure you want to sign out? Your data is stored locally and will remain on this device.")
            }
            .onAppear {
                hasAPIKey = KeychainService.retrieve(
                    service: AppConstants.AI.keychainServiceName,
                    account: AppConstants.AI.keychainAccountName
                ) != nil
            }
        }
    }

    // MARK: Contacts Sync

    private var contactsSyncSection: some View {
        Section {
            Button {
                Task {
                    if await syncService.requestAccess() {
                        await syncService.importContacts(into: modelContext)
                        syncService.startObservingChanges()
                    }
                }
            } label: {
                SettingsRow(
                    icon: "person.crop.rectangle.stack.fill",
                    iconColor: .blue,
                    title: "Import from Contacts",
                    subtitle: syncStatusText
                ) {
                    if syncService.isSyncing {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(syncService.isSyncing)

            if let err = syncService.syncError {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    if err.contains("default.store") || err.contains("couldn't be opened") {
                        Text("The data store failed to open. In Xcode, go to Signing & Capabilities and select a development team, then rebuild. The app will fall back to local storage if CloudKit is unavailable.")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                }
                .padding(.leading, 40)
            }
        } header: {
            Text("Contacts")
        }
    }

    private var syncStatusText: String {
        if syncService.isSyncing {
            return "Syncing..."
        }
        if let date = syncService.lastSyncDate {
            return "Last synced: \(date.relativeDescription)"
        }
        return "Not synced"
    }

    // MARK: iMessage Sync (macOS)

    #if os(macOS)
    private var iMessageSyncSection: some View {
        Section {
            SettingsRow(
                icon: "message.fill",
                iconColor: .green,
                title: "iMessage Sync",
                subtitle: iMessageSyncSubtitle
            ) {
                Toggle("", isOn: Binding(
                    get: { iMessageService.isEnabled },
                    set: { newValue in
                        iMessageService.isEnabled = newValue
                        if newValue {
                            iMessageService.startIfEnabled(with: modelContext)
                        }
                    }
                ))
                .labelsHidden()
            }

            if iMessageService.isRunning {
                SettingsRow(
                    icon: "checkmark.circle.fill",
                    iconColor: .green,
                    title: "Messages Logged",
                    subtitle: nil
                ) {
                    Text("\(iMessageService.messagesProcessed)")
                        .foregroundStyle(.secondary)
                }
            }

            if let err = iMessageService.syncError {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.caption)
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                .padding(.leading, 40)
            }
        } header: {
            Text("iMessage")
        } footer: {
            Text("Automatically logs sent and received iMessages as interactions for matching contacts. Requires Full Disk Access.")
        }
    }

    private var iMessageSyncSubtitle: String {
        if iMessageService.isRunning, let date = iMessageService.lastSyncDate {
            return "Last checked: \(date.relativeDescription)"
        }
        if iMessageService.isRunning {
            return "Running"
        }
        return "Disabled"
    }
    #endif

    // MARK: Hidden Contacts

    private var hiddenContactsSection: some View {
        Section {
            NavigationLink {
                HiddenContactsView()
            } label: {
                SettingsRow(
                    icon: "eye.slash.fill",
                    iconColor: .secondary,
                    title: "Hidden Contacts",
                    subtitle: "View and unhide contacts"
                ) {
                    EmptyView()
                }
            }
        } header: {
            Text("Privacy")
        }
    }

    // MARK: Data

    private var dataSection: some View {
        Section {
            NavigationLink {
                BackupRestoreView()
            } label: {
                SettingsRow(
                    icon: "clock.arrow.circlepath",
                    iconColor: .cyan,
                    title: "Backup & Restore",
                    subtitle: "Version history for your data"
                ) {
                    EmptyView()
                }
            }
        } header: {
            Text("Data")
        }
    }

    // MARK: AI

    private var aiSection: some View {
        Section {
            Button { showAPIKeyEntry = true } label: {
                SettingsRow(
                    icon: "brain",
                    iconColor: .purple,
                    title: "Claude API Key",
                    subtitle: hasAPIKey ? "API key configured" : "No API key set"
                ) {
                    if hasAPIKey {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.body)
                    } else {
                        Text("Configure")
                            .font(.subheadline)
                            .foregroundStyle(AppConstants.UI.accentGold)
                    }
                }
            }
            .buttonStyle(.plain)
        } header: {
            Text("AI Assistant")
        } footer: {
            Text("Powers AI-driven relationship insights and suggestions.")
        }
    }

    // MARK: Google Calendar

    private var googleCalendarSection: some View {
        Section {
            // Client ID row — always visible
            Button { showGoogleClientIdEntry = true } label: {
                SettingsRow(
                    icon: "key.fill",
                    iconColor: .green,
                    title: "OAuth Client ID",
                    subtitle: calendarService.isConfigured
                        ? maskedClientId
                        : "Not configured"
                ) {
                    Text(calendarService.isConfigured ? "Change" : "Configure")
                        .font(.subheadline)
                        .foregroundStyle(AppConstants.UI.accentGold)
                }
            }
            .buttonStyle(.plain)

            if calendarService.isConfigured {
                // Sign in / sign out row
                if calendarService.isSignedIn {
                    Button {
                        calendarService.signOut()
                    } label: {
                        SettingsRow(
                            icon: "calendar",
                            iconColor: .green,
                            title: "Google Calendar",
                            subtitle: "Connected"
                        ) {
                            Text("Sign Out")
                                .font(.subheadline)
                                .foregroundStyle(.red)
                        }
                    }
                    .buttonStyle(.plain)

                    NavigationLink {
                        CalendarPickerView(calendarService: calendarService)
                    } label: {
                        SettingsRow(
                            icon: "checklist",
                            iconColor: .green,
                            title: "Select Calendars",
                            subtitle: calendarSelectionSubtitle
                        ) {
                            EmptyView()
                        }
                    }
                } else {
                    Button {
                        Task { await calendarService.signIn() }
                    } label: {
                        SettingsRow(
                            icon: "calendar",
                            iconColor: .green,
                            title: "Google Calendar",
                            subtitle: "Not signed in"
                        ) {
                            Text("Sign In")
                                .font(.subheadline)
                                .foregroundStyle(AppConstants.UI.accentGold)
                        }
                    }
                    .buttonStyle(.plain)
                }

            }

            NavigationLink {
                RejectedCalendarEventsView()
            } label: {
                SettingsRow(
                    icon: "calendar.badge.minus",
                    iconColor: .secondary,
                    title: "Rejected Calendar Events",
                    subtitle: "View and manage rejected events"
                ) {
                    EmptyView()
                }
            }

            if let error = calendarService.lastError {
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
        } header: {
            Text("Google Calendar")
        } footer: {
            Text("Syncs calendar events as suggested activities on the Activities page.")
        }
    }

    private var maskedClientId: String {
        guard let id = calendarService.clientId else { return "Not configured" }
        let prefix = id.prefix(8)
        return "\(prefix)•••"
    }

    private var calendarSelectionSubtitle: String {
        let count = calendarService.selectedCalendarIds.count
        if count == 0 { return "No calendars selected" }
        return "\(count) calendar\(count == 1 ? "" : "s") selected"
    }

    // MARK: Security

    private var securitySection: some View {
        Section {
            NavigationLink {
                BiometricSettingsView()
            } label: {
                SettingsRow(
                    icon: "faceid",
                    iconColor: .green,
                    title: "App Lock",
                    subtitle: BiometricService.shared.isEnabled ? "Enabled" : "Disabled"
                ) {
                    EmptyView()
                }
            }
        } header: {
            Text("Security")
        }
    }

    // MARK: Subscription

    private var subscriptionSection: some View {
        Section {
            NavigationLink {
                SubscriptionView()
            } label: {
                SettingsRow(
                    icon: "crown.fill",
                    iconColor: AppConstants.UI.accentGold,
                    title: "Subscription",
                    subtitle: "Manage your plan"
                ) {
                    EmptyView()
                }
            }
        } header: {
            Text("Subscription")
        }
    }

    // MARK: Account

    private var accountSection: some View {
        Section {
            Button { showSignOutConfirm = true } label: {
                SettingsRow(
                    icon: "rectangle.portrait.and.arrow.right",
                    iconColor: .red,
                    title: "Sign out of \(authService.displayName ?? "account")?",
                    subtitle: authService.currentUserId.map { _ in "Signed in" }
                ) {
                    EmptyView()
                }
            }
            .buttonStyle(.plain)
        } header: {
            Text("Account")
        }
    }

    // MARK: Scoring

    private var scoringSection: some View {
        Section {
            NavigationLink {
                ScoringSettingsView()
            } label: {
                SettingsRow(
                    icon: "chart.bar.fill",
                    iconColor: .orange,
                    title: "Relationship Scoring",
                    subtitle: "Adjust scoring weights and thresholds"
                ) {
                    EmptyView()
                }
            }
        } header: {
            Text("Scoring")
        }
    }

    // MARK: About

    private var aboutSection: some View {
        Section {
            SettingsRow(
                icon: "info.circle.fill",
                iconColor: .gray,
                title: "Version",
                subtitle: nil
            ) {
                Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.1.1")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("About")
        }
    }
}

// MARK: - Scoring Settings View

struct ScoringSettingsView: View {
    @AppStorage("scoring.recencyWeight") private var recencyWeight = AppConstants.Scoring.recencyWeight
    @AppStorage("scoring.frequencyWeight") private var frequencyWeight = AppConstants.Scoring.frequencyWeight
    @AppStorage("scoring.varietyWeight") private var varietyWeight = AppConstants.Scoring.varietyWeight
    @AppStorage("scoring.sentimentWeight") private var sentimentWeight = AppConstants.Scoring.sentimentWeight
    @AppStorage("scoring.fadingThreshold") private var fadingThreshold = AppConstants.Scoring.fadingThreshold

    private var totalWeight: Double {
        recencyWeight + frequencyWeight + varietyWeight + sentimentWeight
    }

    var body: some View {
        Form {
            Section {
                WeightSlider(label: "Recency", value: $recencyWeight, color: .blue)
                WeightSlider(label: "Frequency", value: $frequencyWeight, color: .green)
                WeightSlider(label: "Variety", value: $varietyWeight, color: .orange)
                WeightSlider(label: "Sentiment", value: $sentimentWeight, color: .purple)
            } header: {
                Text("Weights")
            } footer: {
                HStack {
                    Text("Total:")
                        .foregroundStyle(.secondary)
                    Text(String(format: "%.0f%%", totalWeight * 100))
                        .foregroundColor(abs(totalWeight - 1.0) < 0.01 ? .secondary : .red)
                        .fontWeight(abs(totalWeight - 1.0) < 0.01 ? .regular : .semibold)
                }
                .font(.caption)
            }

            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Fading Alert Threshold")
                            .font(.subheadline)
                        Spacer()
                        Text("\(Int(fadingThreshold))")
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    Slider(value: $fadingThreshold, in: 10...50, step: 5)
                        .tint(AppConstants.UI.fadingRed)
                }
            } header: {
                Text("Thresholds")
            } footer: {
                Text("Contacts scoring below this value will trigger a fading alert.")
            }

            Section {
                Button(role: .destructive) {
                    withAnimation {
                        recencyWeight = AppConstants.Scoring.recencyWeight
                        frequencyWeight = AppConstants.Scoring.frequencyWeight
                        varietyWeight = AppConstants.Scoring.varietyWeight
                        sentimentWeight = AppConstants.Scoring.sentimentWeight
                        fadingThreshold = AppConstants.Scoring.fadingThreshold
                    }
                } label: {
                    HStack {
                        Spacer()
                        Text("Reset to Defaults")
                        Spacer()
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Scoring")
    }
}

// MARK: - Weight Slider

struct WeightSlider: View {
    let label: String
    @Binding var value: Double
    var color: Color = .accentColor

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(label)
                    .font(.subheadline)
                Spacer()
                Text(String(format: "%.0f%%", value * 100))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Slider(value: $value, in: 0...1, step: 0.05)
                .tint(color)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - API Key Entry View

// MARK: - Hidden Contacts View

struct HiddenContactsView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Contact.lastName) private var allContacts: [Contact]
    @State private var showingAddSheet = false
    @State private var searchText = ""

    private var hiddenContacts: [Contact] {
        let hidden = allContacts.filter { $0.isHidden && !$0.isMergedAway }
        if searchText.isEmpty { return hidden }
        return hidden.filter {
            $0.displayName.localizedCaseInsensitiveContains(searchText)
            || ($0.company?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    var body: some View {
        SwiftUI.Group {
            if allContacts.filter({ $0.isHidden && !$0.isMergedAway }).isEmpty {
                ContentUnavailableView {
                    Label("No Hidden Contacts", systemImage: "eye.slash")
                } description: {
                    Text("Contacts you hide will appear here.")
                }
            } else {
                List {
                    ForEach(hiddenContacts) { contact in
                        HStack(spacing: 12) {
                            ContactAvatarView(contact: contact, size: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(contact.displayName)
                                    .font(.body.weight(.medium))
                                if let company = contact.company {
                                    Text(company)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Button {
                                contact.isHidden = false
                                contact.updatedAt = Date()
                                try? modelContext.save()
                            } label: {
                                Text("Unhide")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(AppConstants.UI.accentGold)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.vertical, 2)
                    }
                }
                .searchable(text: $searchText, prompt: "Search hidden contacts...")
            }
        }
        .navigationTitle("Hidden Contacts")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showingAddSheet = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showingAddSheet) {
            HideContactsView()
        }
    }
}

// MARK: - Hide Contacts View

struct HideContactsView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Contact.lastName) private var allContacts: [Contact]
    @State private var selectedIDs: Set<UUID> = []
    @State private var searchText = ""

    private var visibleContacts: [Contact] {
        allContacts.filter { !$0.isHidden && !$0.isMergedAway }
    }

    private var filteredContacts: [Contact] {
        if searchText.isEmpty { return visibleContacts }
        return visibleContacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(searchText)
            || ($0.company?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Search contacts\u{2026}", text: $searchText)
                        .textFieldStyle(.roundedBorder)
                        #if os(macOS)
                        .padding(.vertical, 4)
                        #endif
                }

                Section(searchText.isEmpty ? "All Contacts" : "Results") {
                    if filteredContacts.isEmpty {
                        ContentUnavailableView {
                            Label("No Contacts", systemImage: "person.slash")
                        } description: {
                            Text(searchText.isEmpty
                                 ? "All contacts are already hidden."
                                 : "No matching contacts found.")
                        }
                    } else {
                        ForEach(filteredContacts) { contact in
                            contactRow(contact)
                        }
                    }
                }
            }
            .navigationTitle("Hide Contacts")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Hide (\(selectedIDs.count))") {
                        for contact in allContacts where selectedIDs.contains(contact.id) {
                            contact.isHidden = true
                            contact.updatedAt = Date()
                        }
                        try? modelContext.save()
                        dismiss()
                    }
                    .disabled(selectedIDs.isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 450, idealWidth: 500, minHeight: 500, idealHeight: 600)
        #endif
    }

    private func contactRow(_ contact: Contact) -> some View {
        Button {
            if selectedIDs.contains(contact.id) {
                selectedIDs.remove(contact.id)
            } else {
                selectedIDs.insert(contact.id)
            }
        } label: {
            HStack(spacing: 12) {
                ContactAvatarView(contact: contact, size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text(contact.displayName)
                        .font(.body.weight(.medium))
                    if let company = contact.company {
                        Text(company)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Image(systemName: selectedIDs.contains(contact.id) ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selectedIDs.contains(contact.id) ? AppConstants.UI.accentGold : .secondary)
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Google Client ID Entry View

struct GoogleClientIdEntryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var clientId = ""
    @State private var saved = false
    @State private var saveFailed = false
    var calendarService: GoogleCalendarService

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        SettingsIcon(systemName: "key.fill", color: .green)
                        TextField("Google OAuth Client ID", text: $clientId)
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .autocorrectionDisabled()
                    }
                } footer: {
                    Text("Create an OAuth 2.0 Client ID (iOS type) in your Google Cloud Console with the Calendar API enabled. The redirect URI is derived automatically from your Client ID. Stored securely in the system Keychain.")
                }
                .onAppear {
                    if clientId.isEmpty, let existing = calendarService.clientId {
                        clientId = existing
                    }
                }

                if saved {
                    Section {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Text("Client ID saved successfully")
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if saveFailed {
                    Section {
                        HStack(spacing: 8) {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.red)
                            Text("Failed to save Client ID to Keychain. Please try again.")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Google Calendar Setup")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let trimmed = clientId.trimmingCharacters(in: .whitespacesAndNewlines)
                        saveFailed = false
                        if calendarService.saveClientId(trimmed) {
                            saved = true
                            clientId = ""
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                                dismiss()
                            }
                        } else {
                            saveFailed = true
                        }
                    }
                    .disabled(clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

// MARK: - API Key Entry View

struct APIKeyEntryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var apiKey = ""
    @State private var saved = false
    var onSave: () -> Void = {}

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        SettingsIcon(systemName: "key.fill", color: .purple)
                        SecureField("Enter your Claude API key", text: $apiKey)
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .autocorrectionDisabled()
                    }
                } footer: {
                    Text("Your API key is stored securely in the system Keychain and never leaves this device.")
                }

                if saved {
                    Section {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Text("API key saved successfully")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Claude API Key")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                        KeychainService.save(
                            trimmed,
                            service: AppConstants.AI.keychainServiceName,
                            account: AppConstants.AI.keychainAccountName
                        )
                        saved = true
                        apiKey = ""
                        onSave()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                            dismiss()
                        }
                    }
                    .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
