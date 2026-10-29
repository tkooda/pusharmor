import SwiftUI
import UIKit
import PushArmorCore

struct MessageDetailView: View {
    let row: HistoryRow
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    private var digits: String { DialString.make(row.content) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(row.content)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if row.type == "url" {
                        Button("Open") { model.open(row) }
                            .buttonStyle(GreenButtonStyle())
                    }
                    if row.type == "tel" {
                        Button("Call") {
                            if let u = URL(string: "tel:" + digits) { UIApplication.shared.open(u) }
                        }
                        .buttonStyle(GreenButtonStyle())
                    }
                    HStack(spacing: 12) {
                        Button("Copy") { UIPasteboard.general.string = row.content }
                        ShareLink(item: row.content) {
                            Text("Share")
                        }
                    }
                    .buttonStyle(.bordered)
                }
                .padding(16)
            }
            .navigationTitle("Message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
