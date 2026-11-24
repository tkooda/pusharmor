import XCTest
@testable import PushArmorCore

/// The file row, picker, storage, and paste rules of the app screens (FileUi), with the same
/// words and tables as the Android app and the browser extensions.
final class FileUiTests: XCTestCase {
    let mb: Int64 = 1_000_000
    let now: Int64 = 1_800_000_000

    func testWords() {
        XCTAssertEqual(FileUi.helper, "Larger files expire sooner, between 1 and 24 hours after they are sent")
        XCTAssertEqual(FileUi.onWifi, "On Wi-Fi")
        XCTAssertEqual(FileUi.onMobile, "On mobile data")
        XCTAssertEqual(FileUi.storageTitle, "Storage for received files")
        XCTAssertEqual(FileUi.storageHelper, "When full, the oldest files are removed from this device")
        XCTAssertEqual(FileUi.removed, "Removed from this device")
        XCTAssertEqual(FileUi.willSendFile, "Will be sent as file")
        XCTAssertEqual(FileUi.pasteImageClear, "Clear the message to paste an image")
        XCTAssertEqual(FileUi.noMemoryToast("a.png"), "Not enough memory to decrypt \"a.png\"")
        XCTAssertEqual(FileUi.tooLarge("a.png"), "\"a.png\" is too large to send")
        XCTAssertEqual(FileUi.unreadable("a.png"), "Unable to read \"a.png\"")
        XCTAssertEqual(FileUi.sending(to: ["Laptop"]), "Sending file to \"Laptop\"...")
        XCTAssertEqual(FileUi.sending(to: ["Laptop", "Phone"]), "Sending file to:")
        XCTAssertEqual(S.notEnoughMemory, "Not enough memory to decrypt")
    }

    func testPickers() {
        XCTAssertEqual(FileRules.pickerSizes.map(FileUi.pickerLabel), ["Off", "Up to 10 MB", "Up to 25 MB", "Up to 50 MB", "Up to 100 MB"])
        XCTAssertEqual(FileUi.picker(nil), 50 * mb)
        XCTAssertEqual(FileUi.picker("7"), 50 * mb)
        XCTAssertEqual(FileUi.picker("0"), 0)
        XCTAssertEqual(FileUi.picker("100000000"), 100 * mb)
    }

    func testStorage() {
        XCTAssertEqual(FileUi.storageSizes.map(FileUi.storageLabel), ["100 MB", "500 MB", "1 GB", "5 GB"])
        XCTAssertEqual(FileUi.storageOptions(total: nil), FileUi.storageSizes)
        XCTAssertEqual(FileUi.storageOptions(total: 2_000 * mb), [100 * mb, 500 * mb, 1_000 * mb])
        XCTAssertEqual(FileUi.storageOptions(total: 50 * mb), [100 * mb])
        XCTAssertEqual(FileUi.storageLimit(saved: nil, total: 64_000 * mb), 500 * mb)
        XCTAssertEqual(FileUi.storageLimit(saved: "5000000000", total: 4_000 * mb), 1_000 * mb)
        XCTAssertEqual(FileUi.storageLimit(saved: nil, total: 200 * mb), 100 * mb)
        let files = [FileUi.Stored(id: 1, at: 10, bytes: 300 * mb), FileUi.Stored(id: 2, at: 20, bytes: 300 * mb),
                     FileUi.Stored(id: 3, at: 30, bytes: 0), FileUi.Stored(id: 4, at: 40, bytes: 300 * mb)]
        XCTAssertEqual(FileUi.toRemove(files, limit: 500 * mb), [1, 2])
        XCTAssertEqual(FileUi.toRemove(files, limit: 1_000 * mb), [])
        // the newest file always stays
        XCTAssertEqual(FileUi.toRemove([FileUi.Stored(id: 9, at: 1, bytes: 900 * mb)], limit: 100 * mb), [])
    }

    func testRowText() {
        XCTAssertEqual(FileUi.sizeText(512), "512 bytes")
        XCTAssertEqual(FileUi.sizeText(840_000), "840 KB")
        XCTAssertEqual(FileUi.sizeText(999_600), "1.0 MB")
        XCTAssertEqual(FileUi.sizeText(2_123_456), "2.1 MB")
        XCTAssertEqual(FileUi.expiresText(now + 23 * 3600, nowSec: now), "expires in 23 h")
        XCTAssertEqual(FileUi.expiresText(now + 40 * 60 - 30, nowSec: now), "expires in 40 min")
        XCTAssertEqual(FileUi.expiresText(now, nowSec: now), "Expired")
        XCTAssertEqual(FileUi.typeLabel("a.jpg"), "JPEG image")
        XCTAssertEqual(FileUi.typeLabel("a.pdf"), "PDF")
        XCTAssertEqual(FileUi.typeLabel("a.md"), "Text")
        XCTAssertEqual(FileUi.typeLabel("a.m4a"), "M4A audio")
        XCTAssertEqual(FileUi.typeLabel("a.mp4"), "MP4 video")
        XCTAssertEqual(FileUi.typeLabel("a.zip"), "ZIP archive")
        XCTAssertEqual(FileUi.typeLabel("a.dwg"), "DWG file")
        XCTAssertEqual(FileUi.typeLabel("README"), "File")
        XCTAssertEqual(FileUi.detail("a.pdf", size: 2_123_456), "2.1 MB - PDF")
    }

    func testPaste() {
        XCTAssertEqual(FileUi.paste(clipHasImage: false, textEmpty: true), .text)
        XCTAssertEqual(FileUi.paste(clipHasImage: true, textEmpty: true), .image)
        XCTAssertEqual(FileUi.paste(clipHasImage: true, textEmpty: false), .refuse)
        let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
        XCTAssertEqual(FileUi.pastedImageName(png, timeSec: 0), "image-19700101-000000.png")
        XCTAssertEqual(FileUi.pastedImageName(Data([0xff, 0xd8, 0xff, 0xe0]), timeSec: 0), "image-19700101-000000.jpg")
        XCTAssertEqual(FileUi.pastedImageName(Data([1, 2, 3]), timeSec: 0), "image-19700101-000000.png")
    }

    func testActions() {
        XCTAssertEqual(FileUi.actions(name: "a.png", decodes: true), [.view, .copy, .share, .save])
        XCTAssertEqual(FileUi.actions(name: "a.png", decodes: false), [.open, .share, .save])
        XCTAssertEqual(FileUi.actions(name: "a.pdf", decodes: false), [.open, .share, .save])
        // web content is never previewed: Share and Save only
        for n in ["a.html", "a.HTM", "a.svg", "a.webarchive", "a.mhtml", "a.xhtml"] {
            XCTAssertEqual(FileUi.actions(name: n, decodes: false), [.share, .save], n)
        }
        XCTAssertEqual(FileUi.actions(name: "a.txt", decodes: false), [.open, .share, .save])
        XCTAssertTrue(FileUi.previewNotAvailable(name: "a.png", decodes: false))
        XCTAssertFalse(FileUi.previewNotAvailable(name: "a.pdf", decodes: false))
        XCTAssertEqual(MessageActions.actions(forType: "file"), [])
    }

    private func rec(_ state: String, code: String? = nil, error: String? = nil, expires: Int64? = nil) -> FileRecord {
        var f = FileRecord(dir: .incoming, key: "k", name: "a.pdf", size: 1000, state: state, created: now)
        f.expires = expires ?? now + 3600 * 5
        f.code = code
        f.error = error
        return f
    }

    func testStatus() {
        func st(_ f: FileRecord, plain: Bool = false, received: Int64? = nil) -> FileUi.Status {
            FileUi.status(f, plainThere: plain, received: received, nowSec: now)
        }
        XCTAssertEqual(st(rec("pending")), .pending(expires: "expires in 5 h"))
        XCTAssertEqual(st(rec("pending", expires: now)), .expired)
        XCTAssertEqual(st(rec("loading")), .downloading(percent: 0))
        XCTAssertEqual(st(rec("loading"), received: 514), .downloading(percent: 50))
        XCTAssertEqual(st(rec("loading"), received: 5000), .downloading(percent: 99))
        XCTAssertEqual(st(rec("blob")), .decrypting)
        XCTAssertEqual(st(rec("ready")), .decrypting)
        XCTAssertEqual(st(rec("ready", code: "memory", error: S.notEnoughMemory)), .noMemory)
        XCTAssertEqual(st(rec("ready", code: "failed", error: FileUi.openFailed)), .decryptFailed(text: FileUi.openFailed))
        let full = FileRules.storageFullText(upload: false, name: "a.pdf")
        XCTAssertEqual(st(rec("ready", code: "storage", error: full)), .decryptFailed(text: full))
        XCTAssertEqual(st(rec("done"), plain: true), .ready)
        XCTAssertEqual(st(rec("done")), .failed(text: "Removed from this device", download: true, expires: "expires in 5 h"))
        XCTAssertEqual(st(rec("done", expires: now - 1)), .failed(text: "Removed from this device", download: false, expires: nil))
        XCTAssertEqual(st(rec("failed", code: "expired", error: "Expired")), .expired)
        XCTAssertEqual(st(rec("failed", code: "deleted", error: "Deleted")), .failed(text: "Deleted", download: false, expires: nil))
        XCTAssertEqual(st(rec("failed", code: "damaged", error: FileRules.fileDamaged)),
                       .failed(text: FileRules.fileDamaged, download: false, expires: nil))
        XCTAssertEqual(st(rec("failed", code: "failed")), .failed(text: "Download failed", download: true, expires: "expires in 5 h"))
        let storage = FileRules.storageFullText(upload: false, name: "a.pdf")
        XCTAssertEqual(st(rec("failed", code: "storage", error: storage)), .failed(text: storage, download: true, expires: "expires in 5 h"))
        XCTAssertEqual(st(rec("failed", code: "failed", expires: now)), .failed(text: "Download failed", download: false, expires: nil))
    }

    func testPendingSend() {
        var f = FileRecord(dir: .outgoing, key: "k", name: "a.pdf", size: 1, state: "uploading", created: now)
        XCTAssertTrue(FileUi.pendingSend(f))
        f.state = "failed"
        XCTAssertTrue(FileUi.pendingSend(f))
        f.historyRowid = 3
        XCTAssertFalse(FileUi.pendingSend(f))
        f.historyRowid = nil
        f.state = "sent"
        XCTAssertFalse(FileUi.pendingSend(f))
    }

    /// The oldest decrypted files go first until the rest fit; their rows say "Removed from this device".
    func testEnforceLimit() throws {
        let clock = TestClock()
        let d = try Device(worker: FakeWorker(), clock: clock, name: "Xdev")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        var ids: [Int64] = []
        for (i, size) in [300 * mb, 300 * mb, 300 * mb].enumerated() {
            var f = FileRecord(dir: .incoming, key: "k", name: "f\(i).bin", size: size, state: "done", created: Int64(100 + i))
            f.expires = clock.now + 3600
            f.id = try d.core.store.addFile(f)
            let p = dir.appendingPathComponent(f.plainDirName, isDirectory: true)
            try FileManager.default.createDirectory(at: p, withIntermediateDirectories: true)
            try Data([1]).write(to: p.appendingPathComponent(f.name))
            ids.append(f.id)
        }
        try d.core.fileEnforceLimit(dir: dir, limit: 500 * mb)
        let a = try XCTUnwrap(try d.core.store.file(ids[0])), b = try XCTUnwrap(try d.core.store.file(ids[1]))
        let c = try XCTUnwrap(try d.core.store.file(ids[2]))
        XCTAssertEqual([a.state, b.state, c.state], ["failed", "failed", "done"])
        XCTAssertEqual(a.error, "Removed from this device")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent(a.plainDirName).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent(c.plainDirName).path))
        XCTAssertEqual(FileUi.status(a, plainThere: false, received: nil, nowSec: clock.now),
                       .failed(text: "Removed from this device", download: true, expires: "expires in 1 h"))
    }
}
