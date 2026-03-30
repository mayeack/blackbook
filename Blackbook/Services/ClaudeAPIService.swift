import Foundation
import Observation
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "ClaudeAPI")

/// Provides AI-powered relationship insights via the Claude API.
@Observable
final class ClaudeAPIService {
    private let endpoint = "https://api.anthropic.com/v1/messages"
    private let model = "claude-sonnet-4-20250514"
    private let apiVersion = "2023-06-01"
    private let maxTokens = 1024

    var isLoading = false
    var lastError: String?

    private var apiKey: String? {
        KeychainService.retrieve(service: AppConstants.AI.keychainServiceName, account: AppConstants.AI.keychainAccountName)
    }
    var isConfigured: Bool { apiKey != nil }

    func suggestOutreach(contacts: [Contact]) async -> [OutreachSuggestion] {
        let context = contacts.sorted { $0.relationshipScore < $1.relationshipScore }
            .prefix(AppConstants.AI.maxContextContacts).map { c -> String in
                var p = ["- \(c.firstName) (score: \(Int(c.relationshipScore)))"]
                if let last = c.lastInteractionDate { p.append("  Last contact: \(last.relativeDescription)") }
                if !c.interests.isEmpty { p.append("  Interests: \(c.interests.joined(separator: ", "))") }
                return p.joined(separator: "\n")
            }.joined(separator: "\n\n")
        let prompt = """
        You are a relationship advisor. Based on these contacts and scores (0-100, lower = less engagement), \
        suggest the top 5 people to reach out to and why. Be specific.

        Contacts:
        \(context)

        Respond in JSON: [{"name":"FirstName","reason":"brief reason","priority":"high|medium|low"}]
        """
        guard let response = await sendMessage(prompt) else { return [] }
        return (try? JSONDecoder().decode([OutreachSuggestion].self, from: Data((extractJSON(from: response) ?? "[]").utf8))) ?? []
    }

    func conversationStarters(for contact: Contact) async -> [String] {
        var ctx = "Contact: \(contact.firstName)\n"
        if !contact.interests.isEmpty { ctx += "Interests: \(contact.interests.joined(separator: ", "))\n" }
        if let co = contact.company { ctx += "Works at: \(co)\n" }
        let prompt = "Generate 3 natural conversation starters for reaching out to this person. " +
            "Make them specific.\n\n\(ctx)\n\nRespond in JSON: [\"starter1\",\"starter2\",\"starter3\"]"
        guard let response = await sendMessage(prompt) else { return [] }
        return (try? JSONDecoder().decode([String].self, from: Data((extractJSON(from: response) ?? "[]").utf8))) ?? []
    }

    func networkInsights(contacts: [Contact]) async -> String? {
        let summary = contacts.prefix(30).map {
            "\($0.firstName): score=\(Int($0.relationshipScore)), interactions=\($0.interactions.count)"
        }.joined(separator: "\n")
        return await sendMessage("Analyze this network and provide a brief 3-5 paragraph digest:\n\(summary)")
    }

    func summarizeNotes(for contact: Contact) async -> String? {
        let notes = contact.notes.sorted { $0.createdAt > $1.createdAt }.prefix(20)
            .map { "[\($0.category?.rawValue ?? "General")] \($0.content)" }.joined(separator: "\n---\n")
        guard !notes.isEmpty else { return nil }
        return await sendMessage("Summarize these notes about \(contact.firstName) into key takeaways:\n\(notes)")
    }

    private func sendMessage(_ userMessage: String) async -> String? {
        guard let apiKey else { lastError = "API key not configured"; return nil }
        isLoading = true; lastError = nil
        defer { isLoading = false }
        guard let url = URL(string: endpoint) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue(apiVersion, forHTTPHeaderField: "anthropic-version")
        request.timeoutInterval = 30
        let body: [String: Any] = ["model": model, "max_tokens": maxTokens, "messages": [["role": "user", "content": userMessage]]]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                lastError = "API error (HTTP \(statusCode))"
                logger.error("Claude API returned HTTP \(statusCode)")
                return nil
            }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let content = json["content"] as? [[String: Any]],
                  let text = content.first?["text"] as? String else { return nil }
            return text
        } catch {
            lastError = error.localizedDescription
            logger.error("Claude API request failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// Extracts a JSON array or object from a text response that may contain surrounding markdown.
    func extractJSON(from text: String) -> String? {
        if let s = text.firstIndex(of: "["), let e = text.lastIndex(of: "]") { return String(text[s...e]) }
        if let s = text.firstIndex(of: "{"), let e = text.lastIndex(of: "}") { return String(text[s...e]) }
        return nil
    }
}

struct OutreachSuggestion: Codable, Identifiable {
    let name: String; let reason: String; let priority: String
    var id: String { name }
}
