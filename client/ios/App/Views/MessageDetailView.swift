import SwiftUI
import UIKit
import PushArmorCore

struct MessageDetailView: View {
    let row: HistoryRow
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    private var digits: String { row.content.filter { $0.isASCII && $0.isNumber } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(row.content)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 12) {
                        if row.type == "url" {
                            Button("Open") { model.open(row) }
                        }
                        if row.type == "tel" {
                            Button("Call") {
                                if let u = URL(string: "tel:" + digits) { UIApplication.shared.open(u) }
                            }
                        }
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
