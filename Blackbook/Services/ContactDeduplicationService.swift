import Foundation
import SwiftData
import Observation
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "Dedupe")

/// Finds and merges duplicate Contact records.
///
/// Match key (per product decision): two contacts are linked if they share **any** of:
/// - normalized first+last name
/// - any normalized email
/// - any normalized phone (digits only)
///
/// Connected components of size ≥ 2 form a duplicate group. Within a group the contact
/// with the highest "data richness" score is chosen as the primary; the rest are merged
/// into it via `ContactMergeService` (which sets `isMergedAway = true` and reparents children).
@Observable
final class ContactDeduplicationService {
    struct DuplicateGroup: Identifiable {
        let id = UUID()
        let primary: Contact
        let duplicates: [Contact]
        let matchReason: String
    }

    private(set) var isRunning = false
    private(set) var lastError: String?
    private(set) var lastMergeCount = 0
    private(set) var lastGroupCount = 0

    /// Pure scan — no mutations. Returns groups for inspection.
    func findGroups(in context: ModelContext) throws -> [DuplicateGroup] {
        let descriptor = FetchDescriptor<Contact>(predicate: #Predicate<Contact> { !$0.isMergedAway })
        let contacts = try context.fetch(descriptor)
        guard contacts.count > 1 else { return [] }

        var parent: [UUID: UUID] = [:]
        for c in contacts { parent[c.id] = c.id }

        func find(_ x: UUID) -> UUID {
            var current = x
            while parent[current] != current {
                let p = parent[current]!
                parent[current] = parent[p]
                current = parent[current]!
            }
            return current
        }
        func union(_ a: UUID, _ b: UUID) {
            let ra = find(a), rb = find(b)
            if ra != rb { parent[ra] = rb }
        }

        // Build buckets and merge any time two contacts collide on a normalization key.
        var nameBuckets: [String: [UUID]] = [:]
        var emailBuckets: [String: [UUID]] = [:]
        var phoneBuckets: [String: [UUID]] = [:]
        var contactById: [UUID: Contact] = [:]
        for c in contacts {
            contactById[c.id] = c
            let nameKey = ContactSyncService.nameKey(first: c.firstName, last: c.lastName)
            if !nameKey.isEmpty {
                nameBuckets[nameKey, default: []].append(c.id)
            }
            for e in c.emails {
                let k = ContactSyncService.normalizeEmail(e)
                if !k.isEmpty { emailBuckets[k, default: []].append(c.id) }
            }
            for p in c.phones {
                let k = ContactSyncService.normalizePhone(p)
                if !k.isEmpty { phoneBuckets[k, default: []].append(c.id) }
            }
        }

        for ids in nameBuckets.values where ids.count > 1 {
            for i in 1..<ids.count { union(ids[0], ids[i]) }
        }
        for ids in emailBuckets.values where ids.count > 1 {
            for i in 1..<ids.count { union(ids[0], ids[i]) }
        }
        for ids in phoneBuckets.values where ids.count > 1 {
            for i in 1..<ids.count { union(ids[0], ids[i]) }
        }

        // Group contacts by their root.
        var componentMembers: [UUID: [Contact]] = [:]
        for c in contacts {
            let root = find(c.id)
            componentMembers[root, default: []].append(c)
        }

        var groups: [DuplicateGroup] = []
        for (_, members) in componentMembers where members.count > 1 {
            let sorted = members.sorted { dataRichness(of: $0) > dataRichness(of: $1) }
            let primary = sorted[0]
            let duplicates = Array(sorted.dropFirst())
            let reason = matchReason(for: primary, duplicates: duplicates)
            groups.append(DuplicateGroup(primary: primary, duplicates: duplicates, matchReason: reason))
        }
        return groups.sorted { $0.duplicates.count > $1.duplicates.count }
    }

    /// Auto-merges every duplicate group into its primary. Returns the total number of secondaries merged.
    @discardableResult
    func mergeAll(using merger: ContactMergeService, in context: ModelContext) throws -> Int {
        guard !isRunning else { return 0 }
        isRunning = true
        defer { isRunning = false }
        lastError = nil

        let started = Date()
        let groups: [DuplicateGroup]
        do {
            groups = try findGroups(in: context)
        } catch {
            lastError = error.localizedDescription
            Log.action("contacts.dedupe.scan", success: false, error: error.localizedDescription)
            throw error
        }
        lastGroupCount = groups.count
        Log.action("contacts.dedupe.scan", metadata: ["groupCount": "\(groups.count)"], success: true)

        var mergeCount = 0
        for group in groups {
            for secondary in group.duplicates {
                do {
                    try merger.merge(primary: group.primary, secondary: secondary, context: context)
                    mergeCount += 1
                } catch {
                    lastError = error.localizedDescription
                    logger.warning("Dedup merge failed for \(secondary.id): \(error.localizedDescription)")
                }
            }
        }
        lastMergeCount = mergeCount
        let durationMs = Int(Date().timeIntervalSince(started) * 1000)
        Log.action("contacts.dedupe.merge", metadata: [
            "groupCount": "\(groups.count)",
            "mergedCount": "\(mergeCount)"
        ], durationMs: durationMs, success: true)
        return mergeCount
    }

    // MARK: - Helpers

    private func dataRichness(of c: Contact) -> Double {
        let interactionScore = Double(c.interactions.count) * 3
        let noteScore = Double(c.notes.count) * 2
        let reminderScore = Double(c.reminders.count)
        let tagScore = Double(c.tags.count)
        let groupScore = Double(c.groups.count)
        let activityScore = Double(c.activities.count)
        let fieldScore = Double(c.emails.count + c.phones.count + c.addresses.count)
        let photoBonus: Double = c.photoData != nil ? 5 : 0
        let scoreContribution = c.relationshipScore / 10
        let recencyBonus: Double
        if let last = c.lastInteractionDate {
            let days = -last.timeIntervalSinceNow / 86_400
            recencyBonus = max(0, 30 - days) / 10
        } else {
            recencyBonus = 0
        }
        let ageBonus = max(0, -c.createdAt.timeIntervalSinceNow / 86_400) / 365
        return interactionScore + noteScore + reminderScore + tagScore +
            groupScore + activityScore + fieldScore + photoBonus +
            scoreContribution + recencyBonus + ageBonus
    }

    private func matchReason(for primary: Contact, duplicates: [Contact]) -> String {
        let primaryNameKey = ContactSyncService.nameKey(first: primary.firstName, last: primary.lastName)
        let primaryEmails = Set(primary.emails.map(ContactSyncService.normalizeEmail))
        let primaryPhones = Set(primary.phones.map(ContactSyncService.normalizePhone))
        var reasons: Set<String> = []
        for d in duplicates {
            let dNameKey = ContactSyncService.nameKey(first: d.firstName, last: d.lastName)
            if !dNameKey.isEmpty, dNameKey == primaryNameKey { reasons.insert("Same name") }
            if !primaryEmails.isDisjoint(with: d.emails.map(ContactSyncService.normalizeEmail)) {
                reasons.insert("Shared email")
            }
            if !primaryPhones.isDisjoint(with: d.phones.map(ContactSyncService.normalizePhone)) {
                reasons.insert("Shared phone")
            }
        }
        return reasons.sorted().joined(separator: ", ").ifEmpty("Linked")
    }
}

private extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
