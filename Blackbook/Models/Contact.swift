import Foundation
import SwiftData

struct ContactNavigationID: Hashable {
    let id: UUID
}

@Model
final class Contact {
    var id: UUID
    var cnContactIdentifier: String?
    var firstName: String
    var lastName: String
    var company: String?
    var jobTitle: String?
    var emails: [String]
    var phones: [String]
    var addresses: [String]
    var birthday: Date?
    @Attribute(.externalStorage) var photoData: Data?
    var photoS3Key: String?
    var interests: [String]
    var familyDetails: String?
    var linkedInURL: String?
    var twitterHandle: String?
    var customFields: [String: String]
    var relationshipScore: Double
    var lastInteractionDate: Date?
    var isPriority: Bool
    var isHidden: Bool
    var isMergedAway: Bool
    var createdAt: Date
    var updatedAt: Date

    // Sync tracking
    var syncStatus: String = SyncStatus.pending.rawValue
    var lastSyncedAt: Date?
    var syncVersion: Int = 0

    @Relationship(deleteRule: .cascade, inverse: \Interaction.contact)
    var interactions: [Interaction]

    @Relationship(deleteRule: .cascade, inverse: \Note.contact)
    var notes: [Note]

    @Relationship(inverse: \Tag.contacts)
    var tags: [Tag]

    @Relationship(deleteRule: .cascade, inverse: \Reminder.contact)
    var reminders: [Reminder]

    @Relationship(inverse: \Group.contacts)
    var groups: [Group]

    @Relationship(inverse: \Location.contacts)
    var locations: [Location]

    @Relationship(inverse: \Activity.contacts)
    var activities: [Activity]

    @Relationship(deleteRule: .cascade, inverse: \ContactRelationship.fromContact)
    var connectionsFrom: [ContactRelationship]

    @Relationship(deleteRule: .cascade, inverse: \ContactRelationship.toContact)
    var connectionsTo: [ContactRelationship]

    @Relationship(deleteRule: .nullify, inverse: \Contact.metViaBacklinks)
    var metVia: Contact?

    @Relationship
    var metViaBacklinks: [Contact]

    @Relationship(deleteRule: .nullify, inverse: \Contact.mergedContacts)
    var mergedIntoContact: Contact?

    @Relationship
    var mergedContacts: [Contact]

    var displayName: String {
        let full = "\(firstName) \(lastName)".trimmingCharacters(in: .whitespaces)
        return full.isEmpty ? "Unknown" : full
    }

    var initials: String {
        let f = firstName.first.map(String.init) ?? ""
        let l = lastName.first.map(String.init) ?? ""
        let result = "\(f)\(l)"
        return result.isEmpty ? "?" : result
    }

    var scoreCategory: ScoreCategory {
        switch relationshipScore {
        case 70...100: return .strong
        case 40..<70: return .moderate
        case 10..<40: return .fading
        default: return .dormant
        }
    }

    var scoreTrendRaw: String = ScoreTrend.stable.rawValue

    var scoreTrend: ScoreTrend {
        get { ScoreTrend(rawValue: scoreTrendRaw) ?? .stable }
        set { scoreTrendRaw = newValue.rawValue }
    }

    init(
        firstName: String,
        lastName: String,
        company: String? = nil,
        jobTitle: String? = nil,
        cnContactIdentifier: String? = nil
    ) {
        self.id = UUID()
        self.cnContactIdentifier = cnContactIdentifier
        self.firstName = firstName
        self.lastName = lastName
        self.company = company
        self.jobTitle = jobTitle
        self.emails = []
        self.phones = []
        self.addresses = []
        self.interests = []
        self.customFields = [:]
        self.relationshipScore = 50.0
        self.isPriority = false
        self.isHidden = false
        self.isMergedAway = false
        self.createdAt = Date()
        self.updatedAt = Date()
        self.interactions = []
        self.notes = []
        self.tags = []
        self.groups = []
        self.locations = []
        self.activities = []
        self.reminders = []
        self.connectionsFrom = []
        self.connectionsTo = []
        self.metVia = nil
        self.metViaBacklinks = []
        self.mergedIntoContact = nil
        self.mergedContacts = []
    }
}

enum ScoreCategory: String, Codable {
    case strong = "Strong"
    case moderate = "Moderate"
    case fading = "Fading"
    case dormant = "Dormant"
}

enum ScoreTrend: String, Codable {
    case up, down, stable
}
