import SwiftUI
import UIKit
import UniformTypeIdentifiers
import PushArmorCore

/// A plain text file for the Save action.
struct MessageTextFile: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText] }
    var text: String

    init(text: String) { self.text = text }

    init(configuration: ReadConfiguration) throws {
        text = configuration.file.regularFileContents.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

/// Neutral action button: black text on white, thin gray border, icon above the label.
/// In dark mode the surface turns dark and the text light.
private struct ActionButtonStyle: ButtonStyle {
    private static let surface = UIColor { $0.userInterfaceStyle == .dark ? .secondarySystemBackground : .white }
    private static let pressed = UIColor { $0.userInterfaceStyle == .dark ? .tertiarySystemBackground : .systemGray5 }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color.primary)
            .frame(maxWidth: .infinity, minHeight: 64)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color(uiColor: configuration.isPressed ? Self.pressed : Self.surface)))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(uiColor: .systemGray3), lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 16))
    }
}

private struct ActionLabel: View {
    let title: String
    let icon: String
    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: icon).font(.title3)
            Text(title)
        }
    }
}

private struct SheetHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct BarHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct MessageDetailView: View {
    let row: HistoryRow
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var textHeight: CGFloat = 0
    @State private var barHeight: CGFloat = 0

    private var digits: String { DialString.make(row.content) }

    /// Sheet height that fits the text, the button bar, and the navigation bar; the sheet
    /// can also grow to full screen.
    private var fitHeight: CGFloat { max(240, textHeight + barHeight + 64) }

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(row.content)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(GeometryReader { g in
                        Color.clear.preference(key: SheetHeightKey.self, value: g.size.height)
                    })
                    .onPreferenceChange(SheetHeightKey.self) { textHeight = $0 }
                    .accessibilityIdentifier("messageText")
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                HStack(spacing: 10) {
                    ForEach(MessageActions.actions(forType: row.type), id: \.self) { button($0) }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color(uiColor: .systemBackground))
                .background(GeometryReader { g in
                    Color.clear.preference(key: BarHeightKey.self, value: g.size.height)
                })
                .onPreferenceChange(BarHeightKey.self) { barHeight = $0 }
            }
            .navigationTitle("Message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.height(fitHeight), .large])
        .fileExporter(
            isPresented: $saving,
            document: MessageTextFile(text: row.content),
            contentType: .plainText,
            defaultFilename: MessageActions.saveFilename(epoch: row.createdLocal)
        ) { _ in }
    }

    @ViewBuilder
    private func button(_ a: MessageAction) -> some View {
        switch a {
        case .copy:
            Button { UIPasteboard.general.string = row.content } label: { ActionLabel(title: "Copy", icon: "doc.on.doc") }
                .buttonStyle(ActionButtonStyle())
        case .open:
            Button { openIt() } label: {
                ActionLabel(title: "Open", icon: row.type == "tel" ? "phone" : "arrow.up.right.square")
            }
            .buttonStyle(ActionButtonStyle())
        case .share:
            ShareLink(item: row.content) { ActionLabel(title: "Share", icon: "square.and.arrow.up") }
                .buttonStyle(ActionButtonStyle())
        case .save:
            Button { saving = true } label: { ActionLabel(title: "Save", icon: "square.and.arrow.down") }
                .buttonStyle(ActionButtonStyle())
        }
    }

    private func openIt() {
        model.markRead(row)
        if row.type == "tel" {
            if let u = URL(string: "tel:" + digits) { UIApplication.shared.open(u) }
        } else if let u = URL(string: row.content), URLRule.isOpenable(u) {
            UIApplication.shared.open(u)
        }
    }
}
