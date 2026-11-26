import SwiftUI
import UIKit
import ImageIO
import QuickLook
import UniformTypeIdentifiers
import PushArmorCore

/// The Save action: the system copies the file to the place the user picks (streamed by the
/// system, never read into memory here).
struct FileSaver: UIViewControllerRepresentable {
    let url: URL
    /// The picker closed: nil when saved, else the error (userCancelled when cancelled).
    let onDone: (Error?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let vc = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onDone: (Error?) -> Void

        init(onDone: @escaping (Error?) -> Void) { self.onDone = onDone }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            onDone(urls.isEmpty ? CocoaError(.fileWriteUnknown) : nil)
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { onDone(CocoaError(.userCancelled)) }
    }
}


/// An image from the pasteboard (the Paste button of the message box).
struct PastedImage: Transferable {
    let data: Data

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(importedContentType: .image) { PastedImage(data: $0) }
    }
}

/// The part of a file History row under its header: the state of the transfer and, once the
/// file is on this device, its buttons. A sent file shows its expiry, then the state of its
/// local copy as a received file does (a file sent with no copy kept: its expiry only).
/// Closed, the row shows no expiry.
struct FileRowDetail: View {
    let file: FileRecord
    let outgoing: Bool
    /// The row is open: the expiry shows.
    var open = false
    /// A send to two or more devices: the Recipients list shows while the row is open.
    var recipients: [HistoryRecipients.Line] = []
    @EnvironmentObject var model: AppModel
    @State private var preview: URL?
    @State private var saving = false
    /// The decrypted image decodes (checked once per file).
    @State private var decodes: Bool?

    private var now: Int64 { Int64(Date().timeIntervalSince1970) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if open, sentExpiry, let e = file.expires {
                Text(FileUi.expiresText(e, nowSec: now)).font(.caption).foregroundColor(.secondaryText)
            }
            if open, !recipients.isEmpty { RecipientsList(lines: recipients) }
            if !outgoing || file.state != "sent" {
                incoming
            }
        }
        .quickLookPreview($preview)
        .sheet(isPresented: $saving) {
            FileSaver(url: model.plainURL(file)) { e in
                saving = false
                if let e = e {
                    if let t = FileUi.saveFailed(file.name, e) { model.toast = t }
                } else {
                    model.toast = FileUi.saved(file.name)
                    model.toastIsSuccess = true
                }
            }
            .ignoresSafeArea()
        }
    }

    /// A sent file's expiry line: not when its state shows the expiry (Download) or says Expired.
    private var sentExpiry: Bool {
        guard outgoing else { return false }
        if file.state == "sent" { return true }
        switch model.fileStatus(file) {
        case .pending, .expired: return false
        case .failed(_, let download, _): return !download
        default: return true
        }
    }

    @ViewBuilder
    private var incoming: some View {
        switch model.fileStatus(file) {
        case .pending(let exp):
            downloadRow(exp)
        case .downloading(let p):
            VStack(alignment: .leading, spacing: 4) {
                Label("Downloading \(p)%", systemImage: "arrow.down.circle")
                    .font(.caption)
                    .foregroundColor(.secondaryText)
                ProgressView(value: Double(p), total: 100)
                    .progressViewStyle(.linear)
            }
        case .decrypting:
            // the decrypt's progress by bytes, per whole percent; empty until its first chunk
            ProgressView(value: Double(min((model.fileBytes[file.id] ?? 0) * 100 / max(file.size, 1), 99)), total: 100)
                .progressViewStyle(.linear)
                .accessibilityLabel("Opening")
        case .failed(let text, let download, let exp):
            let removed = text == FileUi.removed
            Label(text, systemImage: removed ? "info.circle" : "exclamationmark.circle.fill")
                .font(.caption)
                .foregroundColor(removed ? .secondaryText : .errorText)
            if download { downloadRow(exp) }
        case .noMemory:
            Label(S.notEnoughMemory, systemImage: "exclamationmark.circle.fill")
                .font(.caption)
                .foregroundColor(.errorText)
            Button { model.decryptNow(file) } label: { Label("Decrypt", systemImage: "lock.open") }
                .buttonStyle(.bordered)
        case .decryptFailed(let text):
            Label(text, systemImage: "exclamationmark.circle.fill")
                .font(.caption)
                .foregroundColor(.errorText)
            Button { model.decryptNow(file) } label: { Label("Decrypt", systemImage: "lock.open") }
                .buttonStyle(.bordered)
        case .expired:
            Label(FileUi.expired, systemImage: "clock")
                .font(.caption)
                .foregroundColor(.secondaryText)
        case .ready:
            ready
        }
    }

    /// The Download button with the expiry right of it.
    private func downloadRow(_ exp: String?) -> some View {
        HStack(spacing: 12) {
            Button { model.downloadFile(file) } label: { Label("Download", systemImage: "arrow.down.circle") }
                .buttonStyle(.bordered)
            if open, let e = exp {
                Text(e).font(.caption).foregroundColor(.secondaryText)
            }
        }
    }

    @ViewBuilder
    private var ready: some View {
        let url = model.plainURL(file)
        let ok = decodes ?? true
        Group {
            if FileUi.previewNotAvailable(name: file.name, decodes: ok) {
                Text(FileUi.previewNA).font(.caption).foregroundColor(.secondaryText)
            }
            HStack(spacing: 10) {
                ForEach(FileUi.actions(name: file.name, decodes: ok), id: \.self) { a in
                    button(a, url)
                }
            }
        }
        .task(id: file.id) {
            guard FileUi.kind(file.name) == .image else { return }
            decodes = await Task.detached { Self.decodes(url) }.value
        }
    }

    /// The image header reads as an image (no full decode of a large file here).
    nonisolated static func decodes(_ url: URL) -> Bool {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(src) > 0 else { return false }
        return CGImageSourceCopyPropertiesAtIndex(src, 0, nil) != nil
    }

    @ViewBuilder
    private func button(_ a: FileUi.Action, _ url: URL) -> some View {
        switch a {
        case .view:
            Button { preview = url } label: { ActionLabel(title: "View", icon: "photo") }
                .buttonStyle(ActionButtonStyle())
        case .open:
            // Quick Look opens it; when it cannot, a toast says no app can
            Button {
                if QLPreviewController.canPreview(url as NSURL) { preview = url } else { model.toast = FileUi.noApp(file.name) }
            } label: { ActionLabel(title: "Open", icon: "arrow.up.right.square") }
                .buttonStyle(ActionButtonStyle())
        case .copy:
            Button { copyImage(url) } label: { ActionLabel(title: "Copy", icon: "doc.on.doc") }
                .buttonStyle(ActionButtonStyle())
        case .share:
            ShareLink(item: url) { ActionLabel(title: "Share", icon: "square.and.arrow.up") }
                .buttonStyle(ActionButtonStyle())
        case .save:
            Button {
                // a file that cannot be read says so at once
                if FileManager.default.isReadableFile(atPath: url.path) {
                    saving = true
                } else if let t = FileUi.saveFailed(file.name, CocoaError(.fileReadNoSuchFile)) {
                    model.toast = t
                }
            } label: { ActionLabel(title: "Save", icon: "square.and.arrow.down") }
                .buttonStyle(ActionButtonStyle())
        }
    }

    private func copyImage(_ url: URL) {
        guard let img = UIImage(contentsOfFile: url.path) else {
            model.toast = FileUi.copyFailed(file.name)
            return
        }
        UIPasteboard.general.image = img
        model.toast = ToastText.copied
        model.toastIsSuccess = true
    }
}

/// A sent file not in History yet: its upload (or the send of its message) runs, or it failed.
struct PendingSendRow: View {
    let file: FileRecord
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IconTile("paperplane")
            VStack(alignment: .leading, spacing: 4) {
                Text(file.name).lineLimit(1).truncationMode(.middle)
                Text(FileUi.detail(file.name, size: file.size)).font(.caption).foregroundColor(.secondaryText)
                if file.state == "failed" {
                    Label(file.error ?? FileTransfers.sendFailedText(file.name), systemImage: "exclamationmark.circle.fill")
                        .font(.caption)
                        .foregroundColor(.errorText)
                    Button("Remove") { model.removePendingSend(file) }
                        .buttonStyle(.bordered)
                } else {
                    let total = file.size + Int64(FileCrypto.overhead)
                    let p = file.state == "uploading" ? Int(min((model.fileBytes[file.id] ?? 0) * 100 / max(total, 1), 99)) : 99
                    Label("Sending \(p)%", systemImage: "arrow.up.circle")
                        .font(.caption)
                        .foregroundColor(.secondaryText)
                    ProgressView(value: Double(p), total: 100)
                        .progressViewStyle(.linear)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Settings: the helper over the two auto-download pickers, then the storage limit.
struct FileSettingsSection: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Section {
            Text(FileUi.helper).font(.caption).foregroundColor(.secondaryText)
            picker(FileUi.onWifi, FileSettingKey.wifi)
            picker(FileUi.onMobile, FileSettingKey.mobile)
            Picker(FileUi.storageTitle, selection: Binding(get: { model.fileStorage }, set: { model.setFileStorage($0) })) {
                ForEach(FileUi.storageOptions(total: model.deviceTotalBytes), id: \.self) { Text(FileUi.storageLabel($0)).tag($0) }
            }
            Text(FileUi.storageHelper).font(.caption).foregroundColor(.secondaryText)
        } header: {
            Text(FileUi.filesHeader)
        }
    }

    private func picker(_ title: String, _ key: String) -> some View {
        Picker(title, selection: Binding(get: { model.filePicker(key) }, set: { model.setFilePicker(key, $0) })) {
            ForEach(FileRules.pickerSizes, id: \.self) { Text(FileUi.pickerLabel($0)).tag($0) }
        }
    }
}
