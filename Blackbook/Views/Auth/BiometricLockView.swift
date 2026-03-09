import SwiftUI

struct BiometricLockView: View {
    @State private var biometricService = BiometricService.shared

    var body: some View {
        ZStack {
            AppConstants.UI.screenBackground
                .ignoresSafeArea()

            VStack(spacing: 32) {
                Spacer()

                VStack(spacing: 16) {
                    Image(systemName: biometricService.biometryIcon)
                        .font(.system(size: 64))
                        .foregroundStyle(AppConstants.UI.accentGold)

                    Text(AppConstants.appName)
                        .font(.largeTitle.bold())

                    Text("Locked")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Button {
                    Task { await biometricService.authenticate() }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: biometricService.biometryIcon)
                        Text("Unlock with \(biometricService.biometryName)")
                    }
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: 300, minHeight: 50)
                    .foregroundStyle(.white)
                    .background(
                        AppConstants.UI.accentGold,
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )
                }
                .buttonStyle(.plain)

                if let error = biometricService.authenticationError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                Spacer()
            }
        }
        .task { await biometricService.authenticate() }
    }
}

struct BiometricSettingsView: View {
    @State private var biometricService = BiometricService.shared
    @State private var isEnabled: Bool = false

    var body: some View {
        Form {
            if biometricService.isBiometricAvailable {
                Section {
                    Toggle(isOn: $isEnabled) {
                        HStack(spacing: 12) {
                            Image(systemName: biometricService.biometryIcon)
                                .font(.title3)
                                .foregroundStyle(AppConstants.UI.accentGold)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Require \(biometricService.biometryName)")
                                Text("Lock the app when it goes to the background")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .onChange(of: isEnabled) { _, newValue in
                        biometricService.setEnabled(newValue)
                    }
                } header: {
                    Text("App Lock")
                } footer: {
                    Text("When enabled, \(biometricService.biometryName) or your device passcode will be required to unlock \(AppConstants.appName).")
                }
            } else {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                        Text("Biometric authentication is not available on this device.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("App Lock")
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("App Lock")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear {
            isEnabled = biometricService.isEnabled
        }
    }
}
