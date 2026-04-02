import SwiftUI

enum AppConstants {
    static let appName = "Blackbook"
    static let cloudKitContainer = "iCloud.com.blackbookdevelopment.app"

    enum AWS {
        static let graphQLAPIName = "blackbookAPI"
        static let s3PhotoPrefix = "contact-photos"
    }

    enum Auth {
        static let keychainServiceName = "com.blackbookdevelopment.auth"
        static let biometricEnabledKey = "biometric-lock-enabled"
    }

    enum Subscription {
        static let monthlyProductId = "com.blackbookdevelopment.pro.monthly"
        static let yearlyProductId = "com.blackbookdevelopment.pro.yearly"
        static let freeContactLimit = 25
    }

    enum Scoring {
        static let recencyWeight: Double = 0.35
        static let frequencyWeight: Double = 0.30
        static let varietyWeight: Double = 0.15
        static let sentimentWeight: Double = 0.20
        static let priorityBoost: Double = 20.0
        static let fadingThreshold: Double = 30.0
        static let recencyHalfLifeDays: Double = 14.0
        static let frequencyWindowDays: Int = 90
        static let activityBoostPerEvent: Double = 5.0
        static let activityBoostCap: Double = 15.0
        static let activityFadeDays: Double = 90.0
    }

    enum AI {
        static let keychainServiceName = "com.blackbookdevelopment.claude-api"
        static let keychainAccountName = "api-key"
        static let maxContextContacts = 20
        static let cacheDurationHours = 24
    }

    enum UI {
        static let accentGold = Color(red: 0.83, green: 0.63, blue: 0.09)
        static let fadingRed = Color(red: 0.85, green: 0.25, blue: 0.20)
        static let strongGreen = Color(red: 0.20, green: 0.78, blue: 0.35)
        static let moderateAmber = Color(red: 0.95, green: 0.70, blue: 0.15)
        static let dormantGray = Color(red: 0.55, green: 0.55, blue: 0.55)
        #if os(iOS)
        static let cardBackground = Color(.systemGray6)
        static let screenBackground = Color(.systemBackground)
        #else
        static let cardBackground = Color(.controlBackgroundColor)
        static let screenBackground = Color(.windowBackgroundColor)
        #endif

        // MARK: - Layout & Typography

        static let profileAvatarSize: CGFloat = 96
        static let scoreRingSize: CGFloat = 80
        static let interactionIconSize: CGFloat = 40
        /// Standard icon size for detail view headers (tags, groups, locations). Use 36pt consistently.
        static let icon1Size: CGFloat = 36
        static let metViaAvatarSize: CGFloat = 36
        static let chipPaddingH: CGFloat = 10
        static let chipPaddingV: CGFloat = 5
        static let cardPadding: CGFloat = 16
        static let sectionSpacing: CGFloat = 20

        static func scoreColor(for score: Double) -> Color {
            switch score {
            case 70...100: return strongGreen
            case 40..<70: return moderateAmber
            case 10..<40: return fadingRed
            default: return dormantGray
            }
        }
    }

    enum GoogleCalendar {
        static let keychainServiceName = "com.blackbookdevelopment.google-calendar"
        static let accessTokenAccount = "access-token"
        static let refreshTokenAccount = "refresh-token"
        static let tokenExpiryAccount = "token-expiry"
        static let clientIdAccount = "client-id"
        static let selectedCalendarsKey = "googleCalendar.selectedCalendarIds"
        static let lastSyncKey = "googleCalendar.lastSyncDate"
        static let syncIntervalHours = 24
        static let eventLookbackDays = 30
        static let authURL = "https://accounts.google.com/o/oauth2/v2/auth"
        static let tokenURL = "https://oauth2.googleapis.com/token"
        static let calendarScope = "https://www.googleapis.com/auth/calendar.readonly"
        static let calendarListURL = "https://www.googleapis.com/calendar/v3/users/me/calendarList"
    }

    enum Backup {
        static let maxBackupsDefault = 10
        static let autoBackupIntervalHours = 24
        static let autoBackupEnabledKey = "backup.autoEnabled"
        static let maxBackupsKey = "backup.maxRetained"
        static let lastAutoBackupKey = "backup.lastAutoDate"
    }

    enum LocalSync {
        static let keychainServiceName = "com.blackbookdevelopment.local-sync"
        static let keychainServerURLAccount = "server-url"
        static let keychainPasswordAccount = "server-password"
        static let serverURL = "https://sync.libersecretorum.com"
    }

    enum IMessageSync {
        static let chatDBPath = "\(NSHomeDirectory())/Library/Messages/chat.db"
        static let pollIntervalSeconds: TimeInterval = 30
        static let lastProcessedROWIDKey = "iMessageSync.lastProcessedROWID"
        static let enabledKey = "iMessageSync.enabled"
    }

    enum Defaults {
        static let reminderLeadTimeDays = 1
        static let autoReminderThreshold: Double = 25.0
        static let maxInteractionSummaryLength = 500
    }

    enum Icons {
        struct Category: Identifiable {
            let id: String
            let name: String
            let icons: [String]
        }

        static let groupCategories: [Category] = [
            Category(id: "general", name: "General", icons: [
                "folder", "tag", "bookmark", "flag",
                "pin", "archivebox", "tray.full"
            ]),
            Category(id: "people", name: "People & Social", icons: [
                "person.2", "person.3", "figure.2", "hand.wave",
                "bubble.left.and.bubble.right",
                "heart", "heart.circle", "hand.thumbsup", "gift"
            ]),
            Category(id: "work", name: "Work & Business", icons: [
                "briefcase", "building.2", "building", "desktopcomputer",
                "doc.text", "chart.bar", "dollarsign.circle",
                "hammer", "wrench.and.screwdriver", "lightbulb"
            ]),
            Category(id: "activities", name: "Activities & Sports", icons: [
                "sportscourt", "figure.run", "figure.hiking",
                "figure.skiing.downhill", "figure.pool.swim",
                "figure.tennis", "bicycle", "dumbbell", "trophy", "medal"
            ]),
            Category(id: "travel", name: "Travel & Places", icons: [
                "airplane", "car", "house", "mappin",
                "globe", "tent", "mountain.2",
                "beach.umbrella", "storefront", "bed.double"
            ]),
            Category(id: "education", name: "Education & Science", icons: [
                "graduationcap", "book", "brain",
                "atom", "flask", "testtube.2",
                "stethoscope", "cross.case"
            ]),
            Category(id: "arts", name: "Arts & Entertainment", icons: [
                "music.note", "guitars", "paintbrush",
                "camera", "film", "theatermasks",
                "gamecontroller", "puzzlepiece", "party.popper"
            ]),
            Category(id: "nature", name: "Nature & Food", icons: [
                "leaf", "tree", "pawprint",
                "sun.max", "cloud", "drop",
                "flame", "fork.knife", "cup.and.saucer"
            ]),
            Category(id: "community", name: "Faith & Community", icons: [
                "star", "star.fill", "sparkles",
                "hands.clap", "cross", "moon.stars",
                "bell", "megaphone"
            ]),
        ]

        static let allGroupIcons: [String] = groupCategories.flatMap(\.icons)
    }
}
