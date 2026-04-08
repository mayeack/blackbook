import Foundation
import SwiftData

/// Shared helpers for serializing all non-Contact models to sync payloads and applying remote JSON.
/// Follows the same pattern as ContactSyncApply.
enum ModelSyncApply {
    private static let iso8601 = ISO8601DateFormatter()

    // MARK: - Tag

    static func tagToDict(_ tag: Tag) -> [String: Any] {
        [
            "id": tag.id.uuidString,
            "name": tag.name,
            "colorHex": tag.colorHex,
            "updatedAt": iso8601.string(from: tag.updatedAt)
        ]
    }

    static func applyRemoteTag(_ dict: [String: Any], to context: ModelContext) throws {
        guard let idString = dict["id"] as? String,
              let remoteId = UUID(uuidString: idString) else { return }

        let predicate = #Predicate<Tag> { $0.id == remoteId }
        let existing = try context.fetch(FetchDescriptor<Tag>(predicate: predicate)).first

        guard let remoteUpdatedStr = dict["updatedAt"] as? String,
              let remoteUpdated = iso8601.date(from: remoteUpdatedStr) else { return }

        if let local = existing {
            if local.updatedAt > remoteUpdated && local.syncStatus != SyncStatus.synced.rawValue { return }
            if let v = dict["name"] as? String { local.name = v }
            if let v = dict["colorHex"] as? String { local.colorHex = v }
            local.updatedAt = remoteUpdated
            local.syncStatus = SyncStatus.synced.rawValue
            local.lastSyncedAt = Date()
        } else {
            let tag = Tag(name: (dict["name"] as? String) ?? "", colorHex: (dict["colorHex"] as? String) ?? "D4A017")
            tag.id = remoteId
            tag.updatedAt = remoteUpdated
            tag.syncStatus = SyncStatus.synced.rawValue
            tag.lastSyncedAt = Date()
            context.insert(tag)
        }
    }

    // MARK: - Group

    static func groupToDict(_ group: Group) -> [String: Any] {
        [
            "id": group.id.uuidString,
            "name": group.name,
            "colorHex": group.colorHex,
            "icon": group.icon,
            "updatedAt": iso8601.string(from: group.updatedAt)
        ]
    }

    static func applyRemoteGroup(_ dict: [String: Any], to context: ModelContext) throws {
        guard let idString = dict["id"] as? String,
              let remoteId = UUID(uuidString: idString) else { return }

        let predicate = #Predicate<Group> { $0.id == remoteId }
        let existing = try context.fetch(FetchDescriptor<Group>(predicate: predicate)).first

        guard let remoteUpdatedStr = dict["updatedAt"] as? String,
              let remoteUpdated = iso8601.date(from: remoteUpdatedStr) else { return }

        if let local = existing {
            if local.updatedAt > remoteUpdated && local.syncStatus != SyncStatus.synced.rawValue { return }
            if let v = dict["name"] as? String { local.name = v }
            if let v = dict["colorHex"] as? String { local.colorHex = v }
            if let v = dict["icon"] as? String { local.icon = v }
            local.updatedAt = remoteUpdated
            local.syncStatus = SyncStatus.synced.rawValue
            local.lastSyncedAt = Date()
        } else {
            let group = Group(name: (dict["name"] as? String) ?? "", colorHex: (dict["colorHex"] as? String) ?? "3498DB", icon: (dict["icon"] as? String) ?? "folder")
            group.id = remoteId
            group.updatedAt = remoteUpdated
            group.syncStatus = SyncStatus.synced.rawValue
            group.lastSyncedAt = Date()
            context.insert(group)
        }
    }

    // MARK: - Location

    static func locationToDict(_ location: Location) -> [String: Any] {
        [
            "id": location.id.uuidString,
            "name": location.name,
            "colorHex": location.colorHex,
            "icon": location.icon,
            "updatedAt": iso8601.string(from: location.updatedAt)
        ]
    }

    static func applyRemoteLocation(_ dict: [String: Any], to context: ModelContext) throws {
        guard let idString = dict["id"] as? String,
              let remoteId = UUID(uuidString: idString) else { return }

        let predicate = #Predicate<Location> { $0.id == remoteId }
        let existing = try context.fetch(FetchDescriptor<Location>(predicate: predicate)).first

        guard let remoteUpdatedStr = dict["updatedAt"] as? String,
              let remoteUpdated = iso8601.date(from: remoteUpdatedStr) else { return }

        if let local = existing {
            if local.updatedAt > remoteUpdated && local.syncStatus != SyncStatus.synced.rawValue { return }
            if let v = dict["name"] as? String { local.name = v }
            if let v = dict["colorHex"] as? String { local.colorHex = v }
            if let v = dict["icon"] as? String { local.icon = v }
            local.updatedAt = remoteUpdated
            local.syncStatus = SyncStatus.synced.rawValue
            local.lastSyncedAt = Date()
        } else {
            let location = Location(name: (dict["name"] as? String) ?? "", colorHex: (dict["colorHex"] as? String) ?? "3498DB", icon: (dict["icon"] as? String) ?? "mappin")
            location.id = remoteId
            location.updatedAt = remoteUpdated
            location.syncStatus = SyncStatus.synced.rawValue
            location.lastSyncedAt = Date()
            context.insert(location)
        }
    }

    // MARK: - Activity

    static func activityToDict(_ activity: Activity) -> [String: Any] {
        var dict: [String: Any] = [
            "id": activity.id.uuidString,
            "name": activity.name,
            "colorHex": activity.colorHex,
            "icon": activity.icon,
            "date": iso8601.string(from: activity.date),
            "activityDescription": activity.activityDescription,
            "createdAt": iso8601.string(from: activity.createdAt),
            "updatedAt": iso8601.string(from: activity.updatedAt),
            "contactIds": activity.contacts.map { $0.id.uuidString },
            "groupIds": activity.groups.map { $0.id.uuidString }
        ]
        if let endDate = activity.endDate { dict["endDate"] = iso8601.string(from: endDate) }
        if let googleEventId = activity.googleEventId { dict["googleEventId"] = googleEventId }
        return dict
    }

    static func applyRemoteActivity(_ dict: [String: Any], to context: ModelContext) throws {
        guard let idString = dict["id"] as? String,
              let remoteId = UUID(uuidString: idString) else { return }

        let predicate = #Predicate<Activity> { $0.id == remoteId }
        let existing = try context.fetch(FetchDescriptor<Activity>(predicate: predicate)).first

        guard let remoteUpdatedStr = dict["updatedAt"] as? String,
              let remoteUpdated = iso8601.date(from: remoteUpdatedStr) else { return }

        if let local = existing {
            if local.updatedAt > remoteUpdated && local.syncStatus != SyncStatus.synced.rawValue { return }
            applyDictToActivity(dict, activity: local, context: context)
            local.updatedAt = remoteUpdated
            local.syncStatus = SyncStatus.synced.rawValue
            local.lastSyncedAt = Date()
        } else {
            let activity = Activity(name: (dict["name"] as? String) ?? "")
            activity.id = remoteId
            applyDictToActivity(dict, activity: activity, context: context)
            activity.updatedAt = remoteUpdated
            activity.syncStatus = SyncStatus.synced.rawValue
            activity.lastSyncedAt = Date()
            context.insert(activity)
        }
    }

    private static func applyDictToActivity(_ dict: [String: Any], activity: Activity, context: ModelContext) {
        if let v = dict["name"] as? String { activity.name = v }
        if let v = dict["colorHex"] as? String { activity.colorHex = v }
        if let v = dict["icon"] as? String { activity.icon = v }
        if let v = dict["date"] as? String, let d = iso8601.date(from: v) { activity.date = d }
        if let v = dict["endDate"] as? String, let d = iso8601.date(from: v) { activity.endDate = d }
        if let v = dict["activityDescription"] as? String { activity.activityDescription = v }
        if let v = dict["createdAt"] as? String, let d = iso8601.date(from: v) { activity.createdAt = d }
        activity.googleEventId = dict["googleEventId"] as? String

        // Resolve group relationships
        if let groupIdStrings = dict["groupIds"] as? [String] {
            let groupIds = groupIdStrings.compactMap { UUID(uuidString: $0) }
            var groups: [Group] = []
            for gid in groupIds {
                let pred = #Predicate<Group> { $0.id == gid }
                if let group = try? context.fetch(FetchDescriptor<Group>(predicate: pred)).first {
                    groups.append(group)
                }
            }
            activity.groups = groups
        }

        // Resolve contact relationships
        if let contactIdStrings = dict["contactIds"] as? [String] {
            let contactIds = contactIdStrings.compactMap { UUID(uuidString: $0) }
            var contacts: [Contact] = []
            for cid in contactIds {
                let pred = #Predicate<Contact> { $0.id == cid }
                if let contact = try? context.fetch(FetchDescriptor<Contact>(predicate: pred)).first {
                    contacts.append(contact)
                }
            }
            activity.contacts = contacts
        }
    }

    // MARK: - Interaction

    static func interactionToDict(_ interaction: Interaction) -> [String: Any] {
        var dict: [String: Any] = [
            "id": interaction.id.uuidString,
            "type": interaction.type.rawValue,
            "date": iso8601.string(from: interaction.date),
            "createdAt": iso8601.string(from: interaction.createdAt),
            "updatedAt": iso8601.string(from: interaction.updatedAt)
        ]
        if let contactId = interaction.contact?.id { dict["contactId"] = contactId.uuidString }
        if let duration = interaction.duration { dict["duration"] = duration }
        if let summary = interaction.summary { dict["summary"] = summary }
        if let sentiment = interaction.sentiment { dict["sentiment"] = sentiment.rawValue }
        if let direction = interaction.directionRaw { dict["directionRaw"] = direction }
        return dict
    }

    static func applyRemoteInteraction(_ dict: [String: Any], to context: ModelContext) throws {
        guard let idString = dict["id"] as? String,
              let remoteId = UUID(uuidString: idString) else { return }

        let predicate = #Predicate<Interaction> { $0.id == remoteId }
        let existing = try context.fetch(FetchDescriptor<Interaction>(predicate: predicate)).first

        guard let remoteUpdatedStr = dict["updatedAt"] as? String,
              let remoteUpdated = iso8601.date(from: remoteUpdatedStr) else { return }

        if let local = existing {
            if local.updatedAt > remoteUpdated && local.syncStatus != SyncStatus.synced.rawValue { return }
            applyDictToInteraction(dict, interaction: local, context: context)
            local.updatedAt = remoteUpdated
            local.syncStatus = SyncStatus.synced.rawValue
            local.lastSyncedAt = Date()
        } else {
            // Need a placeholder contact to create, then replace via apply
            let contact = resolveContact(dict["contactId"] as? String, in: context)
            let interaction = Interaction(
                contact: contact ?? Contact(firstName: "", lastName: ""),
                type: InteractionType(rawValue: (dict["type"] as? String) ?? "Other") ?? .other,
                date: iso8601.date(from: (dict["date"] as? String) ?? "") ?? Date()
            )
            interaction.id = remoteId
            if contact == nil { interaction.contact = nil }
            applyDictToInteraction(dict, interaction: interaction, context: context)
            interaction.updatedAt = remoteUpdated
            interaction.syncStatus = SyncStatus.synced.rawValue
            interaction.lastSyncedAt = Date()
            context.insert(interaction)
        }
    }

    private static func applyDictToInteraction(_ dict: [String: Any], interaction: Interaction, context: ModelContext) {
        if let v = dict["type"] as? String, let t = InteractionType(rawValue: v) { interaction.type = t }
        if let v = dict["date"] as? String, let d = iso8601.date(from: v) { interaction.date = d }
        if let v = dict["createdAt"] as? String, let d = iso8601.date(from: v) { interaction.createdAt = d }
        interaction.duration = dict["duration"] as? TimeInterval
        interaction.summary = dict["summary"] as? String
        if let v = dict["sentiment"] as? String { interaction.sentiment = Sentiment(rawValue: v) }
        interaction.directionRaw = dict["directionRaw"] as? String

        if let contactIdStr = dict["contactId"] as? String {
            interaction.contact = resolveContact(contactIdStr, in: context)
        }
    }

    // MARK: - Note

    static func noteToDict(_ note: Note) -> [String: Any] {
        var dict: [String: Any] = [
            "id": note.id.uuidString,
            "content": note.content,
            "createdAt": iso8601.string(from: note.createdAt),
            "updatedAt": iso8601.string(from: note.updatedAt)
        ]
        if let contactId = note.contact?.id { dict["contactId"] = contactId.uuidString }
        if let category = note.category { dict["category"] = category.rawValue }
        return dict
    }

    static func applyRemoteNote(_ dict: [String: Any], to context: ModelContext) throws {
        guard let idString = dict["id"] as? String,
              let remoteId = UUID(uuidString: idString) else { return }

        let predicate = #Predicate<Note> { $0.id == remoteId }
        let existing = try context.fetch(FetchDescriptor<Note>(predicate: predicate)).first

        guard let remoteUpdatedStr = dict["updatedAt"] as? String,
              let remoteUpdated = iso8601.date(from: remoteUpdatedStr) else { return }

        if let local = existing {
            if local.updatedAt > remoteUpdated && local.syncStatus != SyncStatus.synced.rawValue { return }
            applyDictToNote(dict, note: local, context: context)
            local.updatedAt = remoteUpdated
            local.syncStatus = SyncStatus.synced.rawValue
            local.lastSyncedAt = Date()
        } else {
            let contact = resolveContact(dict["contactId"] as? String, in: context)
            let note = Note(contact: contact ?? Contact(firstName: "", lastName: ""), content: (dict["content"] as? String) ?? "")
            note.id = remoteId
            if contact == nil { note.contact = nil }
            applyDictToNote(dict, note: note, context: context)
            note.updatedAt = remoteUpdated
            note.syncStatus = SyncStatus.synced.rawValue
            note.lastSyncedAt = Date()
            context.insert(note)
        }
    }

    private static func applyDictToNote(_ dict: [String: Any], note: Note, context: ModelContext) {
        if let v = dict["content"] as? String { note.content = v }
        if let v = dict["category"] as? String { note.category = NoteCategory(rawValue: v) }
        if let v = dict["createdAt"] as? String, let d = iso8601.date(from: v) { note.createdAt = d }
        if let contactIdStr = dict["contactId"] as? String {
            note.contact = resolveContact(contactIdStr, in: context)
        }
    }

    // MARK: - Reminder

    static func reminderToDict(_ reminder: Reminder) -> [String: Any] {
        var dict: [String: Any] = [
            "id": reminder.id.uuidString,
            "title": reminder.title,
            "dueDate": iso8601.string(from: reminder.dueDate),
            "isCompleted": reminder.isCompleted,
            "isAutoGenerated": reminder.isAutoGenerated,
            "createdAt": iso8601.string(from: reminder.createdAt),
            "updatedAt": iso8601.string(from: reminder.updatedAt)
        ]
        if let contactId = reminder.contact?.id { dict["contactId"] = contactId.uuidString }
        if let recurrence = reminder.recurrence { dict["recurrence"] = recurrence.rawValue }
        return dict
    }

    static func applyRemoteReminder(_ dict: [String: Any], to context: ModelContext) throws {
        guard let idString = dict["id"] as? String,
              let remoteId = UUID(uuidString: idString) else { return }

        let predicate = #Predicate<Reminder> { $0.id == remoteId }
        let existing = try context.fetch(FetchDescriptor<Reminder>(predicate: predicate)).first

        guard let remoteUpdatedStr = dict["updatedAt"] as? String,
              let remoteUpdated = iso8601.date(from: remoteUpdatedStr) else { return }

        if let local = existing {
            if local.updatedAt > remoteUpdated && local.syncStatus != SyncStatus.synced.rawValue { return }
            applyDictToReminder(dict, reminder: local, context: context)
            local.updatedAt = remoteUpdated
            local.syncStatus = SyncStatus.synced.rawValue
            local.lastSyncedAt = Date()
        } else {
            let contact = resolveContact(dict["contactId"] as? String, in: context)
            let reminder = Reminder(
                contact: contact ?? Contact(firstName: "", lastName: ""),
                title: (dict["title"] as? String) ?? "",
                dueDate: iso8601.date(from: (dict["dueDate"] as? String) ?? "") ?? Date()
            )
            reminder.id = remoteId
            if contact == nil { reminder.contact = nil }
            applyDictToReminder(dict, reminder: reminder, context: context)
            reminder.updatedAt = remoteUpdated
            reminder.syncStatus = SyncStatus.synced.rawValue
            reminder.lastSyncedAt = Date()
            context.insert(reminder)
        }
    }

    private static func applyDictToReminder(_ dict: [String: Any], reminder: Reminder, context: ModelContext) {
        if let v = dict["title"] as? String { reminder.title = v }
        if let v = dict["dueDate"] as? String, let d = iso8601.date(from: v) { reminder.dueDate = d }
        if let v = dict["isCompleted"] as? Bool { reminder.isCompleted = v }
        if let v = dict["isAutoGenerated"] as? Bool { reminder.isAutoGenerated = v }
        if let v = dict["recurrence"] as? String { reminder.recurrence = Recurrence(rawValue: v) }
        if let v = dict["createdAt"] as? String, let d = iso8601.date(from: v) { reminder.createdAt = d }
        if let contactIdStr = dict["contactId"] as? String {
            reminder.contact = resolveContact(contactIdStr, in: context)
        }
    }

    // MARK: - ContactRelationship

    static func contactRelationshipToDict(_ rel: ContactRelationship) -> [String: Any] {
        var dict: [String: Any] = [
            "id": rel.id.uuidString,
            "updatedAt": iso8601.string(from: rel.updatedAt)
        ]
        if let fromId = rel.fromContact?.id { dict["fromContactId"] = fromId.uuidString }
        if let toId = rel.toContact?.id { dict["toContactId"] = toId.uuidString }
        if let label = rel.label { dict["label"] = label }
        if let strength = rel.strength { dict["strength"] = strength }
        return dict
    }

    static func applyRemoteContactRelationship(_ dict: [String: Any], to context: ModelContext) throws {
        guard let idString = dict["id"] as? String,
              let remoteId = UUID(uuidString: idString) else { return }

        let predicate = #Predicate<ContactRelationship> { $0.id == remoteId }
        let existing = try context.fetch(FetchDescriptor<ContactRelationship>(predicate: predicate)).first

        guard let remoteUpdatedStr = dict["updatedAt"] as? String,
              let remoteUpdated = iso8601.date(from: remoteUpdatedStr) else { return }

        if let local = existing {
            if local.updatedAt > remoteUpdated && local.syncStatus != SyncStatus.synced.rawValue { return }
            applyDictToRelationship(dict, rel: local, context: context)
            local.updatedAt = remoteUpdated
            local.syncStatus = SyncStatus.synced.rawValue
            local.lastSyncedAt = Date()
        } else {
            let fromContact = resolveContact(dict["fromContactId"] as? String, in: context)
            let toContact = resolveContact(dict["toContactId"] as? String, in: context)
            guard let from = fromContact, let to = toContact else { return }
            let rel = ContactRelationship(from: from, to: to)
            rel.id = remoteId
            applyDictToRelationship(dict, rel: rel, context: context)
            rel.updatedAt = remoteUpdated
            rel.syncStatus = SyncStatus.synced.rawValue
            rel.lastSyncedAt = Date()
            context.insert(rel)
        }
    }

    private static func applyDictToRelationship(_ dict: [String: Any], rel: ContactRelationship, context: ModelContext) {
        rel.label = dict["label"] as? String
        rel.strength = dict["strength"] as? Double
        if let fromIdStr = dict["fromContactId"] as? String {
            rel.fromContact = resolveContact(fromIdStr, in: context)
        }
        if let toIdStr = dict["toContactId"] as? String {
            rel.toContact = resolveContact(toIdStr, in: context)
        }
    }

    // MARK: - RejectedCalendarEvent

    static func rejectedEventToDict(_ event: RejectedCalendarEvent) -> [String: Any] {
        [
            "id": event.id.uuidString,
            "googleEventId": event.googleEventId,
            "title": event.title,
            "eventDate": iso8601.string(from: event.eventDate),
            "calendarName": event.calendarName,
            "rejectedAt": iso8601.string(from: event.rejectedAt),
            "updatedAt": iso8601.string(from: event.updatedAt)
        ]
    }

    static func applyRemoteRejectedEvent(_ dict: [String: Any], to context: ModelContext) throws {
        guard let idString = dict["id"] as? String,
              let remoteId = UUID(uuidString: idString) else { return }

        let predicate = #Predicate<RejectedCalendarEvent> { $0.id == remoteId }
        let existing = try context.fetch(FetchDescriptor<RejectedCalendarEvent>(predicate: predicate)).first

        guard let remoteUpdatedStr = dict["updatedAt"] as? String,
              let remoteUpdated = iso8601.date(from: remoteUpdatedStr) else { return }

        if let local = existing {
            if local.updatedAt > remoteUpdated && local.syncStatus != SyncStatus.synced.rawValue { return }
            if let v = dict["googleEventId"] as? String { local.googleEventId = v }
            if let v = dict["title"] as? String { local.title = v }
            if let v = dict["eventDate"] as? String, let d = iso8601.date(from: v) { local.eventDate = d }
            if let v = dict["calendarName"] as? String { local.calendarName = v }
            if let v = dict["rejectedAt"] as? String, let d = iso8601.date(from: v) { local.rejectedAt = d }
            local.updatedAt = remoteUpdated
            local.syncStatus = SyncStatus.synced.rawValue
            local.lastSyncedAt = Date()
        } else {
            let event = RejectedCalendarEvent(
                googleEventId: (dict["googleEventId"] as? String) ?? "",
                title: (dict["title"] as? String) ?? "",
                eventDate: iso8601.date(from: (dict["eventDate"] as? String) ?? "") ?? Date(),
                calendarName: (dict["calendarName"] as? String) ?? ""
            )
            event.id = remoteId
            if let v = dict["rejectedAt"] as? String, let d = iso8601.date(from: v) { event.rejectedAt = d }
            event.updatedAt = remoteUpdated
            event.syncStatus = SyncStatus.synced.rawValue
            event.lastSyncedAt = Date()
            context.insert(event)
        }
    }

    // MARK: - Helpers

    private static func resolveContact(_ idString: String?, in context: ModelContext) -> Contact? {
        guard let idString, let id = UUID(uuidString: idString) else { return nil }
        let predicate = #Predicate<Contact> { $0.id == id }
        return try? context.fetch(FetchDescriptor<Contact>(predicate: predicate)).first
    }
}
