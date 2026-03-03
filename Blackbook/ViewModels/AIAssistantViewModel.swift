import Foundation
import Observation
import SwiftData

@Observable
final class AIAssistantViewModel {
    let claudeService = ClaudeAPIService()
    let enrichmentService = SocialEnrichmentService()

    var outreachSuggestions: [OutreachSuggestion] = []
    var conversationStarters: [String] = []
    var networkInsight: String?
    var noteSummary: String?

    var isConfigured: Bool { claudeService.isConfigured }

    func loadOutreachSuggestions(contacts: [Contact]) async {
        outreachSuggestions = await claudeService.suggestOutreach(contacts: contacts)
    }
    func loadConversationStarters(for contact: Contact) async {
        conversationStarters = await claudeService.conversationStarters(for: contact)
    }
    func loadNetworkInsights(contacts: [Contact]) async {
        networkInsight = await claudeService.networkInsights(contacts: contacts)
    }
    func loadNoteSummary(for contact: Contact) async {
        noteSummary = await claudeService.summarizeNotes(for: contact)
    }
    func enrichContact(_ contact: Contact) async {
        guard let result = await enrichmentService.enrichFromLinkedIn(contact: contact) else { return }
        enrichmentService.applyEnrichment(result, to: contact)
    }
}
