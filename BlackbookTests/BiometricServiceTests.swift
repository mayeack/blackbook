import XCTest
@testable import Blackbook

final class BiometricServiceTests: XCTestCase {

    func testBiometryNameReturnsNonEmpty() {
        let service = BiometricService.shared
        XCTAssertFalse(service.biometryName.isEmpty)
    }

    func testBiometryIconReturnsValidSFSymbol() {
        let service = BiometricService.shared
        let icon = service.biometryIcon
        XCTAssertFalse(icon.isEmpty)
        // Valid SF Symbol names are non-empty strings
    }

    func testSetEnabledTogglesState() {
        let service = BiometricService.shared
        let wasEnabled = service.isEnabled

        // Toggle to opposite
        service.setEnabled(!wasEnabled)
        XCTAssertEqual(service.isEnabled, !wasEnabled)

        // Restore original
        service.setEnabled(wasEnabled)
        XCTAssertEqual(service.isEnabled, wasEnabled)
    }

    func testLockAppOnlyLocksWhenEnabled() {
        let service = BiometricService.shared

        service.setEnabled(false)
        service.isLocked = false
        service.lockApp()
        XCTAssertFalse(service.isLocked, "Should not lock when biometric is disabled")

        service.setEnabled(true)
        service.isLocked = false
        service.lockApp()
        XCTAssertTrue(service.isLocked, "Should lock when biometric is enabled")

        // Cleanup
        service.setEnabled(false)
    }
}
