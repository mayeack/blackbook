import Foundation
import SwiftData

enum Feature {
    case unlimitedContacts
    case aiInsights
    case googleCalendar
    case advancedNetwork
    case dataExport
    case prioritySupport
}

enum FeatureGating {
    static func isAvailable(_ feature: Feature) -> Bool {
        let tier = SubscriptionManager.shared.currentTier
        switch feature {
        case .unlimitedContacts, .aiInsights, .googleCalendar,
             .advancedNetwork, .dataExport, .prioritySupport:
            return tier == .pro
        }
    }

    static func canAddContact(currentCount: Int) -> Bool {
        if SubscriptionManager.shared.isPro { return true }
        return currentCount < AppConstants.Subscription.freeContactLimit
    }

    static var contactLimitReached: Bool {
        false // Evaluated dynamically in views with access to model context
    }

    static var freeContactLimit: Int {
        AppConstants.Subscription.freeContactLimit
    }

    static func featureDescription(_ feature: Feature) -> String {
        switch feature {
        case .unlimitedContacts: return "Unlimited contacts"
        case .aiInsights: return "AI-powered insights"
        case .googleCalendar: return "Google Calendar sync"
        case .advancedNetwork: return "Advanced network graph"
        case .dataExport: return "Data export"
        case .prioritySupport: return "Priority support"
        }
    }

    static var proFeatures: [Feature] {
        [.unlimitedContacts, .aiInsights, .googleCalendar,
         .advancedNetwork, .dataExport, .prioritySupport]
    }
}
