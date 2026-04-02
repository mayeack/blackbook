import Foundation
import SwiftData

/// Shared helpers for serializing Contact to sync payloads and applying remote contact JSON to a context.
/// Used by the local Mac sync server and LocalServerSyncService.
enum ContactSyncApply {
    private static let iso8601 = ISO8601DateFormatter()
    private static let dateOnly = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f }()

    static func contactToDict(_ contact: Contact) -> [String: Any] {
        var dict: [String: Any] = [
            "id": contact.id.uuidString,
            "firstName": contact.firstName,
            "lastName": contact.lastName,
            "emails": contact.emails,
            "phones": contact.phones,
            "addresses": contact.addresses,
            "interests": contact.interests,
            "relationshipScore": contact.relationshipScore,
            "isPriority": contact.isPriority,
            "isHidden": contact.isHidden,
            "isMergedAway": contact.isMergedAway,
            "scoreTrendRaw": contact.scoreTrendRaw,
            "createdAt": iso8601.string(from: contact.createdAt),
            "updatedAt": iso8601.string(from: contact.updatedAt),
            "tagIds": contact.tags.map { $0.id.uuidString },
            "groupIds": contact.groups.map { $0.id.uuidString },
            "locationIds": contact.locations.map { $0.id.uuidString },
            "activityIds": contact.activities.map { $0.id.uuidString }
        ]
        if let company = contact.company { dict["company"] = company }
        if let jobTitle = contact.jobTitle { dict["jobTitle"] = jobTitle }
        if let familyDetails = contact.familyDetails { dict["familyDetails"] = familyDetails }
        if let linkedInURL = contact.linkedInURL { dict["linkedInURL"] = linkedInURL }
        if let twitterHandle = contact.twitterHandle { dict["twitterHandle"] = twitterHandle }
        if let instagramHandle = contact.instagramHandle { dict["instagramHandle"] = instagramHandle }
        if let lastInteractionDate = contact.lastInteractionDate {
            dict["lastInteractionDate"] = iso8601.string(from: lastInteractionDate)
        }
        if let birthday = contact.birthday {
            dict["birthday"] = dateOnly.string(from: birthday)
        }
        if !contact.customFields.isEmpty {
            dict["customFields"] = (try? String(
                data: JSONSerialization.data(withJSONObject: contact.customFields),
                encoding: .utf8
            )) ?? "{}"
        }
        return dict
    }

    static func applyRemoteContact(_ dict: [String: Any], to context: ModelContext) throws {
        guard let idString = dict["id"] as? String,
              let remoteId = UUID(uuidString: idString) else { return }

        let predicate = #Predicate<Contact> { $0.id == remoteId }
        let descriptor = FetchDescriptor<Contact>(predicate: predicate)
        let existing = try context.fetch(descriptor).first

        guard let remoteUpdatedStr = dict["updatedAt"] as? String,
              let remoteUpdated = iso8601.date(from: remoteUpdatedStr) else { return }

        if let local = existing {
            if local.updatedAt > remoteUpdated && local.syncStatus != SyncStatus.synced.rawValue {
                local.syncStatus = SyncStatus.conflict.rawValue
                return
            }
            applyDictToContact(dict, contact: local)
            local.syncStatus = SyncStatus.synced.rawValue
            local.lastSyncedAt = Date()
        } else {
            let contact = Contact(
                firstName: (dict["firstName"] as? String) ?? "",
                lastName: (dict["lastName"] as? String) ?? ""
            )
            contact.id = remoteId
            applyDictToContact(dict, contact: contact)
            contact.syncStatus = SyncStatus.synced.rawValue
            contact.lastSyncedAt = Date()
            context.insert(contact)
        }
    }

    private static func applyDictToContact(_ dict: [String: Any], contact: Contact) {
        if let v = dict["firstName"] as? String { contact.firstName = v }
        if let v = dict["lastName"] as? String { contact.lastName = v }
        contact.company = dict["company"] as? String
        contact.jobTitle = dict["jobTitle"] as? String
        contact.familyDetails = dict["familyDetails"] as? String
        contact.linkedInURL = dict["linkedInURL"] as? String
        contact.twitterHandle = dict["twitterHandle"] as? String
        contact.instagramHandle = dict["instagramHandle"] as? String
        if let v = dict["relationshipScore"] as? Double { contact.relationshipScore = v }
        if let v = dict["isPriority"] as? Bool { contact.isPriority = v }
        if let v = dict["isHidden"] as? Bool { contact.isHidden = v }
        if let v = dict["isMergedAway"] as? Bool { contact.isMergedAway = v }
        if let v = dict["scoreTrendRaw"] as? String { contact.scoreTrendRaw = v }
        if let v = dict["emails"] as? [String] { contact.emails = v }
        if let v = dict["phones"] as? [String] { contact.phones = v }
        if let v = dict["addresses"] as? [String] { contact.addresses = v }
        if let v = dict["interests"] as? [String] { contact.interests = v }
        if let v = dict["updatedAt"] as? String, let date = iso8601.date(from: v) { contact.updatedAt = date }
        if let v = dict["createdAt"] as? String, let date = iso8601.date(from: v) { contact.createdAt = date }
        if let v = dict["lastInteractionDate"] as? String, let date = iso8601.date(from: v) { contact.lastInteractionDate = date }
        if let v = dict["birthday"] as? String { contact.birthday = dateOnly.date(from: v) }
        if let v = dict["customFields"] as? String,
           let data = v.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            contact.customFields = obj
        }
        // tagIds, groupIds, locationIds, activityIds: we don't resolve relationships in this apply (server stores flat; client may resolve later or we add in Phase 2)
    }
}
