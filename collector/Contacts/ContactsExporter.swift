import Contacts
import CryptoKit
import Foundation

struct LabeledValue: Equatable {
    let label: String?
    let value: String
}

struct PostalItem: Equatable {
    let label: String?
    let street: String?
    let city: String?
    let state: String?
    let postalCode: String?
    let country: String?
    let isoCountryCode: String?
}

struct SocialItem: Equatable {
    let service: String?
    let username: String?
    let url: String?
}

/// One address-book card, flattened for `GET /v1/contacts`.
struct ContactCard: Equatable {
    var id: String
    var given: String?
    var family: String?
    var nickname: String?
    var org: String?
    var job: String?
    var phones: [LabeledValue] = []
    var emails: [LabeledValue] = []
    var postal: [PostalItem] = []
    var birthday: (y: Int?, m: Int, d: Int)?
    var social: [SocialItem] = []
    var urls: [LabeledValue] = []

    static func == (a: ContactCard, b: ContactCard) -> Bool {
        a.json == b.json
    }

    var json: JSON {
        func labeled(_ items: [LabeledValue]) -> JSON {
            .array(items.map { .object([("label", .str($0.label)), ("value", .string($0.value))]) })
        }
        var birthdayJSON = JSON.null
        if let b = birthday {
            var pairs: [(String, JSON)] = []
            if let y = b.y { pairs.append(("y", .num(y))) }
            pairs.append(("m", .num(b.m)))
            pairs.append(("d", .num(b.d)))
            birthdayJSON = .object(pairs)
        }
        return .object([
            ("id", .string(id)),
            ("given", .str(given)),
            ("family", .str(family)),
            ("nickname", .str(nickname)),
            ("org", .str(org)),
            ("job", .str(job)),
            ("phones", labeled(phones)),
            ("emails", labeled(emails)),
            ("postal", .array(postal.map {
                .object([("label", .str($0.label)), ("street", .str($0.street)), ("city", .str($0.city)),
                         ("state", .str($0.state)), ("postal_code", .str($0.postalCode)), ("country", .str($0.country)),
                         ("iso_country_code", .str($0.isoCountryCode))])
            })),
            ("birthday", birthdayJSON),
            ("social", .array(social.map {
                .object([("service", .str($0.service)), ("username", .str($0.username)), ("url", .str($0.url))])
            })),
            ("urls", labeled(urls)),
        ])
    }
}

enum ContactsAuthorization: String {
    case granted, denied, notDetermined = "not_determined", restricted, unknown
}

/// Address-book access; `SystemContactsSource` in production, a fake in tests.
protocol ContactsSource: AnyObject {
    func authorization() -> ContactsAuthorization
    func requestAccess()
    func fetchAll() throws -> [ContactCard]
}

enum ContactsExport {
    /// Items sorted by id, plus a SHA-256 (hex) over their canonical JSON so Node can skip
    /// unchanged dumps.
    static func payload(_ cards: [ContactCard]) -> (hash: String, items: [JSON]) {
        let items = cards.sorted { $0.id < $1.id }.map(\.json)
        let digest = SHA256.hash(data: JSON.array(items).serialized())
        return (digest.map { String(format: "%02x", $0) }.joined(), items)
    }
}

/// CNContactStore reader. Never writes to Contacts.
final class SystemContactsSource: ContactsSource {
    private let store = CNContactStore()

    func authorization() -> ContactsAuthorization {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown
        }
    }

    func requestAccess() {
        store.requestAccess(for: .contacts) { _, _ in }
    }

    func fetchAll() throws -> [ContactCard] {
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey, CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey,
            CNContactOrganizationNameKey, CNContactJobTitleKey, CNContactPhoneNumbersKey,
            CNContactEmailAddressesKey, CNContactPostalAddressesKey, CNContactBirthdayKey,
            CNContactSocialProfilesKey, CNContactUrlAddressesKey,
        ] as [CNKeyDescriptor]
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.unifyResults = true
        var cards: [ContactCard] = []
        try store.enumerateContacts(with: request) { contact, _ in
            cards.append(Self.card(from: contact))
        }
        return cards
    }

    static func card(from c: CNContact) -> ContactCard {
        var card = ContactCard(id: c.identifier, given: nilIfEmpty(c.givenName), family: nilIfEmpty(c.familyName),
                               nickname: nilIfEmpty(c.nickname), org: nilIfEmpty(c.organizationName),
                               job: nilIfEmpty(c.jobTitle))
        card.phones = c.phoneNumbers.map { LabeledValue(label: label($0.label), value: $0.value.stringValue) }
        card.emails = c.emailAddresses.map { LabeledValue(label: label($0.label), value: $0.value as String) }
        card.postal = c.postalAddresses.map {
            let a = $0.value
            return PostalItem(label: label($0.label), street: nilIfEmpty(a.street), city: nilIfEmpty(a.city),
                              state: nilIfEmpty(a.state), postalCode: nilIfEmpty(a.postalCode),
                              country: nilIfEmpty(a.country), isoCountryCode: nilIfEmpty(a.isoCountryCode.uppercased()))
        }
        if let b = c.birthday, let m = b.month, let d = b.day, m != NSDateComponentUndefined, d != NSDateComponentUndefined {
            let y = b.year.flatMap { $0 == NSDateComponentUndefined ? nil : $0 }
            card.birthday = (y: y, m: m, d: d)
        }
        // Service comes from the value, not the label (fixes ContactSyncService.swift:391-399).
        card.social = c.socialProfiles.map {
            let p = $0.value
            return SocialItem(service: nilIfEmpty(p.service), username: nilIfEmpty(p.username), url: nilIfEmpty(p.urlString))
        }
        card.urls = c.urlAddresses.map { LabeledValue(label: label($0.label), value: $0.value as String) }
        return card
    }

    private static func label(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        return CNLabeledValue<NSString>.localizedString(forLabel: raw).lowercased()
    }

    private static func nilIfEmpty(_ s: String) -> String? { s.isEmpty ? nil : s }
}
