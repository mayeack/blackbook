import SwiftUI
import SwiftData

struct AIInsightsView: View {
    @Query(sort: \Contact.relationshipScore) private var allContacts: [Contact]
    @State private var viewModel = AIAssistantViewModel()
    private var contacts: [Contact] { allContacts.filter { !$0.isHidden && !$0.isMergedAway } }
    @State private var tab: AITab = .outreach
    enum AITab: String, CaseIterable, Identifiable { case outreach = "Outreach", insights = "Network"; var id: String { rawValue } }

    var body: some View {
        VStack(spacing: 0) {
            if !viewModel.isConfigured {
                ContentUnavailableView { Label("AI Not Configured", systemImage: "brain") } description: { Text("Add your Claude API key in Settings.") }
            } else {
                Picker("Tab", selection: $tab) { ForEach(AITab.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.segmented).padding()
                ScrollView {
                    VStack(spacing: 16) {
                        if tab == .outreach {
                            Button { Task { await viewModel.loadOutreachSuggestions(contacts: contacts) } } label: {
                                Label(viewModel.claudeService.isLoading ? "Thinking..." : "Get Suggestions", systemImage: "sparkles").frame(maxWidth: .infinity)
                            }.buttonStyle(.borderedProminent).tint(AppConstants.UI.accentGold).disabled(viewModel.claudeService.isLoading).padding(.horizontal)
                            ForEach(viewModel.outreachSuggestions) { s in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack { Text(s.name).font(.headline); Spacer(); Text(s.priority.capitalized).font(.caption.weight(.bold)).foregroundStyle(.white).padding(.horizontal, 8).padding(.vertical, 2).background(s.priority == "high" ? AppConstants.UI.fadingRed : AppConstants.UI.moderateAmber, in: Capsule()) }
                                    Text(s.reason).font(.subheadline).foregroundStyle(.secondary)
                                }.padding().background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 12)).padding(.horizontal)
                            }
                        } else {
                            Button { Task { await viewModel.loadNetworkInsights(contacts: contacts) } } label: {
                                Label(viewModel.claudeService.isLoading ? "Analyzing..." : "Analyze Network", systemImage: "chart.bar.doc.horizontal").frame(maxWidth: .infinity)
                            }.buttonStyle(.borderedProminent).tint(AppConstants.UI.accentGold).disabled(viewModel.claudeService.isLoading).padding(.horizontal)
                            if let insight = viewModel.networkInsight { Text(insight).font(.subheadline).padding().background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 12)).padding(.horizontal) }
                        }
                    }.padding(.vertical)
                }
            }
        }.navigationTitle("AI Assistant")
    }
}

struct ContactAIView: View {
    let contact: Contact
    @State private var viewModel = AIAssistantViewModel()
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !viewModel.isConfigured { Label("Configure Claude API in Settings for AI features", systemImage: "info.circle").font(.caption).foregroundStyle(.secondary) }
            else {
                HStack { Text("Conversation Starters").font(.subheadline.weight(.semibold)); Spacer()
                    Button { Task { await viewModel.loadConversationStarters(for: contact) } } label: { Label("Generate", systemImage: "sparkles").font(.caption) }.buttonStyle(.bordered).tint(AppConstants.UI.accentGold).disabled(viewModel.claudeService.isLoading) }
                ForEach(viewModel.conversationStarters, id: \.self) { Text($0).font(.subheadline).padding(10).background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 8)) }
                HStack { Text("Notes Summary").font(.subheadline.weight(.semibold)); Spacer()
                    Button { Task { await viewModel.loadNoteSummary(for: contact) } } label: { Label("Summarize", systemImage: "doc.text.magnifyingglass").font(.caption) }.buttonStyle(.bordered).tint(AppConstants.UI.accentGold).disabled(viewModel.claudeService.isLoading || contact.notes.isEmpty) }
                if let s = viewModel.noteSummary { Text(s).font(.subheadline).padding(10).background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 8)) }
            }
        }
    }
}
