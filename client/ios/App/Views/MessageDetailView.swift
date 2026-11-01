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

/// Read-only text that stays selectable, so part of it can be copied or shared.
struct SelectableText: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let v = UITextView()
        v.isEditable = false
        v.isSelectable = true
        v.backgroundColor = .clear
        v.font = UIFont.preferredFont(forTextStyle: .title3)
        v.adjustsFontForContentSizeCategory = true
        v.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
        v.text = text
        return v
    }

    func updateUIView(_ v: UITextView, context: Context) {
        if v.text != text { v.text = text }
    }
}

/// Tonal action button: icon above the label.
private struct ActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color.primary)
            .frame(maxWidth: .infinity, minHeight: 64)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color.brandGreen.opacity(configuration.isPressed ? 0.30 : 0.18)))
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

struct MessageDetailView: View {
    let row: HistoryRow
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var reading = false
    @State private var saving = false

    private var digits: String { DialString.make(row.content) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if row.type == "url" || row.type == "tel" {
                        Text(row.content)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        textBox
                    }
                    HStack(spacing: 10) {
                        ForEach(MessageActions.actions(forType: row.type), id: \.self) { button($0) }
                    }
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
        .fullScreenCover(isPresented: $reading) { ReadMessageView(text: row.content) }
        .fileExporter(
            isPresented: $saving,
            document: MessageTextFile(text: row.content),
            contentType: .plainText,
            defaultFilename: MessageActions.saveFilename(epoch: row.createdLocal)
        ) { _ in }
    }

    @ViewBuilder
    private var textBox: some View {
        let box = Text(row.content)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        Group {
            if MessageActions.scrolls(row.content) {
                ScrollView { box }
                    .frame(height: UIFont.preferredFont(forTextStyle: .body).lineHeight * CGFloat(MessageActions.previewLines) + 24)
            } else {
                box
            }
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(uiColor: .secondarySystemBackground)))
        .accessibilityIdentifier("messageTextBox")
    }

    @ViewBuilder
    private func button(_ a: MessageAction) -> some View {
        switch a {
        case .read:
            Button { reading = true } label: { ActionLabel(title: "View", icon: "text.alignleft") }
                .buttonStyle(ActionButtonStyle())
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

/// Near-full-screen reader: the text and an X at the top right.
struct ReadMessageView: View {
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            SelectableText(text: text)
                .padding(.top, 44)
                .accessibilityIdentifier("readText")
            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(Color.secondary)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("Close")
            .accessibilityIdentifier("readClose")
            .padding(8)
        }
        .background(Color(uiColor: .systemBackground))
    }
}
