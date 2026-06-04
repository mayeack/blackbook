import Foundation
import SwiftData

/// Wrapper for navigating to a specific contact by ID.
struct ContactNavigationID: Hashable {
    let id: UUID
}

/// Core model representing a person in the user's relationship network.
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
    var instagramHandle: String?
    var customFields: [String: String]
    var relationshipScore: Double
    var lastInteractionDate: Date?
    var isPriority: Bool
    var isHidden: Bool
    var isMergedAway: Bool
    var createdAt: Date
    var updatedAt: Date = Date()

    // Sync tracking
    var syncStatus: String = SyncStatus.pending.rawValue
    var lastSyncedAt: Date?
    var syncVersion: Int = 0

    // MARK: - Source-device provenance

    var createdByDeviceId: String?
    var createdByPlatform: String?
    var createdByDeviceName: String?
    var lastEditedByDeviceId: String?
    var lastEditedByPlatform: String?
    var lastEditedByDeviceName: String?

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

    /// Full name of the contact, falling back to "Unknown" if both names are empty.
    var displayName: String {
        let full = "\(firstName) \(lastName)".trimmingCharacters(in: .whitespaces)
        return full.isEmpty ? "Unknown" : full
    }

    /// First letters of first and last name, or "?" if unavailable.
    var initials: String {
        let f = firstName.first.map(String.init) ?? ""
        let l = lastName.first.map(String.init) ?? ""
        let result = "\(f)\(l)"
        return result.isEmpty ? "?" : result
    }

    /// Categorizes the relationship score into strong, moderate, fading, or dormant.
    var scoreCategory: ScoreCategory {
        switch relationshipScore {
        case 70...100: return .strong
        case 40..<70: return .moderate
        case 10..<40: return .fading
        default: return .dormant
        }
    }

    var scoreTrendRaw: String = ScoreTrend.stable.rawValue

    /// Whether the relationship score is trending up, down, or stable.
    var scoreTrend: ScoreTrend {
        get { ScoreTrend(rawValue: scoreTrendRaw) ?? .stable }
        set { scoreTrendRaw = newValue.rawValue }
    }

    /// Creates a new contact with default score of 50 and empty collections.
    /// - Parameters:
    ///   - firstName: Contact's first name.
    ///   - lastName: Contact's last name.
    ///   - cnContactIdentifier: Optional identifier linking to a system CNContact.
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
        self.createdByDeviceId = DeviceIdentity.installId
        self.createdByPlatform = DeviceIdentity.platform
        self.createdByDeviceName = DeviceIdentity.deviceName
        self.lastEditedByDeviceId = DeviceIdentity.installId
        self.lastEditedByPlatform = DeviceIdentity.platform
        self.lastEditedByDeviceName = DeviceIdentity.deviceName
    }

    /// Mark this record as locally edited: bumps `updatedAt`, flips `syncStatus` to `.pending`
    /// (unless already `.deleted`), and refreshes the three `lastEditedBy*` fields to the
    /// current device. Use everywhere a local user action mutates the record.
    func markLocallyEdited() {
        updatedAt = Date()
        if syncStatus != SyncStatus.deleted.rawValue {
            syncStatus = SyncStatus.pending.rawValue
        }
        lastEditedByDeviceId = DeviceIdentity.installId
        lastEditedByPlatform = DeviceIdentity.platform
        lastEditedByDeviceName = DeviceIdentity.deviceName
    }
}

extension Sequence where Element == Contact {
    /// Contacts eligible to appear in any list, picker, or search surface — excludes hidden and
    /// merged-away contacts. Single chokepoint for the CLAUDE.md rule "Hidden contacts must never
    /// appear outside Settings > Hidden Contacts." Use everywhere contacts are offered for selection.
    var selectable: [Contact] {
        filter { !$0.isHidden && !$0.isMergedAway }
    }
}

/// Buckets for relationship health based on numeric score thresholds.
enum ScoreCategory: String, Codable {
    case strong = "Strong"
    case moderate = "Moderate"
    case fading = "Fading"
    case dormant = "Dormant"
}

/// Directional trend of a contact's relationship score over time.
enum ScoreTrend: String, Codable {
    case up, down, stable
}
