import Foundation
import Observation
import LinkPresentation

@Observable
final class SocialEnrichmentService {
    var isLoading = false
    var lastError: String?

    struct EnrichmentResult {
        var title: String?
        var description: String?
    }

    func enrichFromLinkedIn(contact: Contact) async -> EnrichmentResult? {
        guard let urlString = contact.linkedInURL, let url = URL(string: urlString) else {
            lastError = "No LinkedIn URL configured"; return nil
        }
        isLoading = true; lastError = nil
        defer { isLoading = false }
        do {
            let provider = LPMetadataProvider()
            provider.timeout = 10
            let metadata = try await provider.startFetchingMetadata(for: url)
            return EnrichmentResult(title: metadata.title)
        } catch { lastError = "Could not fetch profile: \(error.localizedDescription)"; return nil }
    }

    func applyEnrichment(_ result: EnrichmentResult, to contact: Contact) {
        if let title = result.title {
            let components = title.components(separatedBy: " - ")
            if components.count >= 2 {
                contact.jobTitle = contact.jobTitle ?? components.first?.trimmingCharacters(in: .whitespaces)
                contact.company = contact.company ?? components.dropFirst().first?.trimmingCharacters(in: .whitespaces)
            }
        }
        contact.updatedAt = Date()
        contact.customFields["lastEnriched"] = ISO8601DateFormatter().string(from: Date())
    }
}
