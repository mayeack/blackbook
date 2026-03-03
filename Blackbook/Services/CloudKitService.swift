import Foundation
import Observation
import CloudKit

@Observable
final class CloudKitService {
    var accountStatus: CKAccountStatus = .couldNotDetermine
    var statusDescription: String = "Checking..."

    func checkAccountStatus() async {
        do {
            let status = try await CKContainer(identifier: AppConstants.cloudKitContainer).accountStatus()
            accountStatus = status
            switch status {
            case .available: statusDescription = "iCloud available"
            case .noAccount: statusDescription = "No iCloud account"
            case .restricted: statusDescription = "iCloud restricted"
            case .couldNotDetermine: statusDescription = "Unable to determine status"
            case .temporarilyUnavailable: statusDescription = "Temporarily unavailable"
            @unknown default: statusDescription = "Unknown status"
            }
        } catch { statusDescription = "Error: \(error.localizedDescription)" }
    }
}
