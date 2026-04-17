import SwiftUI
import SwiftData

/// Settings tool that scans for duplicate contacts and merges them in one tap.
/// Matches by name, shared email, or shared phone (the moderate match key).
/// Merged contacts are recoverable via Settings → Hidden Contacts.
struct DuplicateScanView: View {
    @Environment(\.modelContext) private var modelContext
    @State private var dedupeService = ContactDeduplicationService()
    @State private var mergeService = ContactMergeService()
    @State private var lastResult: Result?
    @State private var isWorking = false
    @State private var errorMessage: String?

    private struct Result {
        let groupCount: Int
        let mergedCount: Int
    }

    var body: some View {
        Form {
            Section {
                Text("Scans every contact and merges any that share a name, an email, or a phone number. Merged contacts are not deleted — they're tagged as merged and recoverable via Hidden Contacts.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                Button(role: .destructive) {
                    runScan()
                } label: {
                    HStack {
                        if isWorking {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "person.2.slash")
                        }
                        Text(isWorking ? "Scanning…" : "Scan & Merge Duplicates")
                    }
                }
                .disabled(isWorking)
            }

            if let result = lastResult {
                Section("Last result") {
                    LabeledContent("Duplicate groups found", value: "\(result.groupCount)")
                    LabeledContent("Contacts merged", value: "\(result.mergedCount)")
                    if result.mergedCount == 0 {
                        Text("No duplicates detected.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Merged contacts are recoverable via Settings → Hidden Contacts.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Find Duplicates")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private func runScan() {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        let context = modelContext
        let dedup = dedupeService
        let merger = mergeService
        Task.detached {
            do {
                let groups = try dedup.findGroups(in: context)
                let merged = try dedup.mergeAll(using: merger, in: context)
                await MainActor.run {
                    lastResult = Result(groupCount: groups.count, mergedCount: merged)
                    isWorking = false
                }
                await UserActionLogger.shared.uploadPending()
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isWorking = false
                }
            }
        }
    }
}
