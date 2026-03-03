import Foundation
import SwiftData
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "ContactMerge")

final class ContactMergeService {

    func merge(primary: Contact, secondary: Contact, context: ModelContext) throws {
        guard primary.id != secondary.id else { return }

        mergeScalarFields(into: primary, from: secondary)
        mergeArrayFields(into: primary, from: secondary)
        mergeScoreAndMetadata(into: primary, from: secondary)
        reparentChildren(into: primary, from: secondary)
        unionMemberships(into: primary, from: secondary)
        mergeConnectionEdges(into: primary, from: secondary, context: context)
        mergeMetVia(into: primary, from: secondary)

        secondary.isMergedAway = true
        secondary.mergedIntoContact = primary
        primary.updatedAt = Date()
        secondary.updatedAt = Date()

        try context.save()
        logger.info("Merged '\(secondary.displayName)' into '\(primary.displayName)'")
    }

    // MARK: - Scalar Fields

    private func mergeScalarFields(into primary: Contact, from secondary: Contact) {
        if primary.company == nil || primary.company?.isEmpty == true {
            primary.company = secondary.company
        }
        if primary.jobTitle == nil || primary.jobTitle?.isEmpty == true {
            primary.jobTitle = secondary.jobTitle
        }
        if primary.birthday == nil {
            primary.birthday = secondary.birthday
        }
        if primary.familyDetails == nil || primary.familyDetails?.isEmpty == true {
            primary.familyDetails = secondary.familyDetails
        }
        if primary.linkedInURL == nil || primary.linkedInURL?.isEmpty == true {
            primary.linkedInURL = secondary.linkedInURL
        }
        if primary.twitterHandle == nil || primary.twitterHandle?.isEmpty == true {
            primary.twitterHandle = secondary.twitterHandle
        }
        if primary.photoData == nil {
            primary.photoData = secondary.photoData
        }
    }

    // MARK: - Array Fields

    private func mergeArrayFields(into primary: Contact, from secondary: Contact) {
        primary.emails = Array(Set(primary.emails).union(secondary.emails))
        primary.phones = Array(Set(primary.phones).union(secondary.phones))
        primary.addresses = orderedUnion(primary.addresses, secondary.addresses)
        primary.interests = orderedUnion(primary.interests, secondary.interests)

        var merged = secondary.customFields
        for (key, value) in primary.customFields {
            merged[key] = value
        }
        primary.customFields = merged
    }

    private func orderedUnion(_ a: [String], _ b: [String]) -> [String] {
        var seen = Set(a)
        var result = a
        for item in b where !seen.contains(item) {
            seen.insert(item)
            result.append(item)
        }
        return result
    }

    // MARK: - Score & Metadata

    private func mergeScoreAndMetadata(into primary: Contact, from secondary: Contact) {
        primary.relationshipScore = max(primary.relationshipScore, secondary.relationshipScore)

        if let secDate = secondary.lastInteractionDate {
            if let priDate = primary.lastInteractionDate {
                primary.lastInteractionDate = max(priDate, secDate)
            } else {
                primary.lastInteractionDate = secDate
            }
        }

        if secondary.isPriority {
            primary.isPriority = true
        }
    }

    // MARK: - Child Relationships (re-parent)

    private func reparentChildren(into primary: Contact, from secondary: Contact) {
        for interaction in secondary.interactions {
            interaction.contact = primary
        }
        for note in secondary.notes {
            note.contact = primary
        }
        for reminder in secondary.reminders {
            reminder.contact = primary
        }
    }

    // MARK: - Many-to-Many Memberships

    private func unionMemberships(into primary: Contact, from secondary: Contact) {
        let existingTagIDs = Set(primary.tags.map(\.id))
        for tag in secondary.tags where !existingTagIDs.contains(tag.id) {
            primary.tags.append(tag)
        }

        let existingGroupIDs = Set(primary.groups.map(\.id))
        for group in secondary.groups where !existingGroupIDs.contains(group.id) {
            primary.groups.append(group)
        }

        let existingLocationIDs = Set(primary.locations.map(\.id))
        for location in secondary.locations where !existingLocationIDs.contains(location.id) {
            primary.locations.append(location)
        }

        let existingActivityIDs = Set(primary.activities.map(\.id))
        for activity in secondary.activities where !existingActivityIDs.contains(activity.id) {
            primary.activities.append(activity)
        }
    }

    // MARK: - ContactRelationship Edges

    private func mergeConnectionEdges(into primary: Contact, from secondary: Contact, context: ModelContext) {
        let existingFromPairs = Set(primary.connectionsFrom.compactMap { edge -> String? in
            guard let toID = edge.toContact?.id else { return nil }
            return "\(primary.id)-\(toID)"
        })
        let existingToPairs = Set(primary.connectionsTo.compactMap { edge -> String? in
            guard let fromID = edge.fromContact?.id else { return nil }
            return "\(fromID)-\(primary.id)"
        })

        for edge in Array(secondary.connectionsFrom) {
            guard let toContact = edge.toContact else { continue }
            if toContact.id == primary.id {
                context.delete(edge)
                continue
            }
            let pairKey = "\(primary.id)-\(toContact.id)"
            if existingFromPairs.contains(pairKey) {
                context.delete(edge)
            } else {
                edge.fromContact = primary
            }
        }

        for edge in Array(secondary.connectionsTo) {
            guard let fromContact = edge.fromContact else { continue }
            if fromContact.id == primary.id {
                context.delete(edge)
                continue
            }
            let pairKey = "\(fromContact.id)-\(primary.id)"
            if existingToPairs.contains(pairKey) {
                context.delete(edge)
            } else {
                edge.toContact = primary
            }
        }
    }

    // MARK: - Met Via / Backlinks

    private func mergeMetVia(into primary: Contact, from secondary: Contact) {
        for contact in secondary.metViaBacklinks {
            contact.metVia = primary
        }

        if primary.metVia == nil, let secMetVia = secondary.metVia, secMetVia.id != primary.id {
            primary.metVia = secMetVia
        }

        secondary.metVia = nil
    }
}
