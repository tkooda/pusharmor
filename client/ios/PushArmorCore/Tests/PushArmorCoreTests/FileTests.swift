import XCTest
@testable import PushArmorCore

/// tests/vectors/file-v1.json (names, collision, auto_download, sha256, file_sig, upload_request),
/// the status table, the attempt count, the file message, and the send and receive state machine
/// over two devices and the fake Worker.
final class FileTests: XCTestCase {
    typealias J = [String: Any]

    static let vectors: J = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tests/vectors/file-v1.json")
        return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! J
    }()

    static func section(_ k: String) -> J { vectors[k] as! J }
    static func cases(_ k: String) -> [J] { section(k)["cases"] as! [J] }
    func i64(_ v: Any?) -> Int64 { (v as! NSNumber).int64Value }
    func b(_ v: Any?) -> Data { B64URL.decode(v as! String)! }

    // MARK: vectors

    func testNameVectors() {
        let time = i64(Self.section("names")["time"])
        let cases = Self.cases("names")
        XCTAssertGreaterThanOrEqual(cases.count, 40)
        for c in cases {
            let t = (c["time"] as? NSNumber)?.int64Value ?? time
            XCTAssertEqual(FileName.sanitize(c["input"] as! String, timeSec: t, image: c["image"] as! Bool), c["output"] as! String,
                           "\(c)")
        }
    }

    func testCollisionVectors() {
        for c in Self.cases("collision") {
            XCTAssertEqual(FileName.collide(c["input"] as! String, existing: c["existing"] as! [String]), c["output"] as! String,
                           c["name"] as! String)
        }
    }

    /// The catch-up table: network x picker x size -> download, for phones (both pickers), browsers and the command line.
    func testAutoDownloadVectors() {
        let cases = Self.cases("auto_download")
        XCTAssertGreaterThanOrEqual(cases.count, 100)
        for c in cases {
            let size = i64(c["size"])
            let got: Bool
            switch c["client"] as! String {
            case "phone":
                let net: FileRules.Network = c["network"] as! String == "wifi" ? .wifi : .mobile
                let p = i64(c["picker"])
                let other = FileRules.pickerSizes.last! - p   // the other picker must not matter
                let lowData = c["data_saver"] as! Bool
                let picker = net == .wifi ? FileRules.pickerFor(net, wifi: p, mobile: other, lowData: lowData)
                    : FileRules.pickerFor(net, wifi: other, mobile: p, lowData: lowData)
                got = FileRules.autoDownload(picker: picker, size: size)
                    && FileRules.catchUpDue(size: size, expires: 2000, picker: picker, localNowSec: 1999)
            case "browser": got = FileRules.autoDownload(picker: i64(c["picker"]), size: size)
            default: got = FileRules.autoDownload(picker: FileRules.pickerSizes.last!, size: size)
            }
            XCTAssertEqual(got, c["download"] as! Bool, "\(c)")
        }
    }

    func testSHA256Vectors() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("filehash-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        for c in Self.cases("sha256") {
            let d = b(c["input"])
            XCTAssertEqual(FileHash.of(d), c["sha256"] as! String, c["name"] as! String)
            let f = dir.appendingPathComponent(c["name"] as! String)
            try d.write(to: f)
            XCTAssertEqual(FileHash.of(file: f), c["sha256"] as! String, c["name"] as! String)
        }
    }

    func testFileSigVectors() {
        let cases = Self.cases("file_sig")
        XCTAssertEqual(cases.count, 5)
        for c in cases {
            let name = c["name"] as! String
            let signed: Data
            if c["method"] as! String == "POST" {
                signed = FileSig.postBytes(paTime: c["pa_time"] as! String, contentLength: i64(c["content_length"]),
                                           sha256: c["file_sha256"] as! String, sendId: c["send_id"] as! String)
            } else {
                XCTAssertEqual(c["path"] as! String, "/v1/file/" + (c["id"] as! String), name)
                signed = FileSig.deleteBytes(id: c["id"] as! String, paTime: c["pa_time"] as! String)
            }
            XCTAssertEqual(signed, b(c["signed_bytes"]), name)
            XCTAssertEqual(String(decoding: signed, as: UTF8.self), c["signed_text"] as! String, name)
            XCTAssertEqual(Signatures.verify(b(c["sig"]), data: signed, publicKey: b(c["sign_pub"])), c["verifies"] as! Bool, name)
        }
    }

    func testUploadRequestVector() throws {
        let v = Self.section("upload_request")
        let h = v["headers"] as! [String: String]
        let body = b(v["body"])
        XCTAssertEqual(v["path"] as! String, "/v1/file")
        XCTAssertEqual(h["Content-Length"], String(body.count))
        XCTAssertEqual(h["PA-File-SHA256"], FileHash.of(body))
        let signed = FileSig.postBytes(paTime: h["PA-Time"]!, contentLength: Int64(body.count), sha256: h["PA-File-SHA256"]!,
                                       sendId: h["PA-Send-ID"]!)
        XCTAssertEqual(signed, b(v["signed_bytes"]))
        XCTAssertTrue(Signatures.verify(b(h["PA-Sig"]), data: signed, publicKey: b(v["sign_pub"])))
        // the body opens with the key to the plaintext
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fileup-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let input = dir.appendingPathComponent("blob"), out = dir.appendingPathComponent("plain")
        try body.write(to: input)
        try FileCrypto.decrypt(input: input, output: out, key: b(v["key"]))
        XCTAssertEqual(try Data(contentsOf: out), b(v["plaintext"]))
        XCTAssertEqual(i64(Self.section("constants")["MAX_FILE"]), FileRules.maxFile)
        XCTAssertEqual(i64(Self.section("constants")["BLOB_OVERHEAD"]), Int64(FileCrypto.overhead))
    }

    // MARK: rules

    func testCatchUpNeverStartsAtOrAfterExpires() {
        XCTAssertTrue(FileRules.catchUpDue(size: 1, expires: 100, picker: FileRules.defaultPicker, localNowSec: 99))
        XCTAssertFalse(FileRules.catchUpDue(size: 1, expires: 100, picker: FileRules.defaultPicker, localNowSec: 100))
        XCTAssertFalse(FileRules.catchUpDue(size: 1, expires: 100, picker: 0, localNowSec: 0))
    }

    func testFreeSpace() {
        XCTAssertTrue(FileRules.enoughStorage(free: nil, size: 100_000_000))
        XCTAssertTrue(FileRules.enoughStorage(free: 2 * 1000 + 10_000_000, size: 1000))
        XCTAssertFalse(FileRules.enoughStorage(free: 2 * 1000 + 10_000_000 - 1, size: 1000))
        XCTAssertEqual(FileRules.storageFullText(upload: false, name: "a.pdf"), "Not enough storage to download \"a.pdf\"")
        XCTAssertEqual(FileRules.storageFullText(upload: true, name: "a.pdf"), "Not enough storage to send \"a.pdf\"")
    }

    func testStatusTable() {
        func up(_ s: Int, _ e: String? = nil, _ ra: Int64? = nil) -> FileRules.Outcome {
            FileRules.fileStatus(upload: true, status: s, error: e, retryAfter: ra)
        }
        func down(_ s: Int, _ e: String? = nil, _ ra: Int64? = nil, now: Int64 = 0, exp: Int64 = 0) -> FileRules.Outcome {
            FileRules.fileStatus(upload: false, status: s, error: e, retryAfter: ra, nowSec: now, expires: exp)
        }
        XCTAssertEqual(up(429, "file quota", 3601), .final(.quota, "You reached your file limit. Try again in 2 hours"))
        XCTAssertEqual(up(429, "file quota"), .final(.quota, "You reached your file limit. Try again later"))
        XCTAssertEqual(up(429, "rate limited", 30), .retry(30))
        XCTAssertEqual(down(503, "files paused", 300), .final(.paused, "File sending is over quota and paused for 5 minutes"))
        XCTAssertEqual(up(503, "files paused"), .final(.paused, "File sending is paused. Try again later"))
        XCTAssertEqual(up(0), .retry(nil))
        XCTAssertEqual(down(502), .retry(nil))
        XCTAssertEqual(up(500, "x", 0), .retry(nil))
        XCTAssertEqual(up(426), .final(.update, nil))
        XCTAssertEqual(up(413), .final(.tooLarge, nil))
        XCTAssertEqual(up(403, "unapproved"), .final(.failed, nil))
        XCTAssertEqual(down(410), .final(.expired, "Expired"))
        XCTAssertEqual(down(404, "update required"), .final(.update, "Update the app"))
        XCTAssertEqual(down(404, now: 99, exp: 100), .final(.deleted, "Deleted"))
        XCTAssertEqual(down(404, now: 100, exp: 100), .final(.expired, "Expired"))
        XCTAssertEqual(down(403), .final(.failed, "Download failed"))
    }

    func testWaits() {
        XCTAssertEqual(FileRules.fileWait(1), "1 minute")
        XCTAssertEqual(FileRules.fileWait(3540), "59 minutes")
        XCTAssertEqual(FileRules.fileWait(3599), "1 hour")
        XCTAssertEqual(FileRules.fileWait(3600), "1 hour")
        XCTAssertEqual(FileRules.fileWait(3601), "2 hours")
        XCTAssertEqual(FileRules.fileWait(47 * 3600), "47 hours")
        XCTAssertEqual(FileRules.fileWait(47 * 3600 + 1), "2 days")
        XCTAssertEqual(FileRules.fileWait(2 * 86400 + 1), "3 days")
    }

    func testAttemptsCapAtFive() {
        var a = FileRules.Attempts()
        for _ in 0 ..< 5 { a = a.start(have: 0)!.end() }
        XCTAssertEqual(a.used, 5)
        XCTAssertNil(a.start(have: 0))
    }

    /// A system stop that gained bytes does not count; one that gained none does.
    func testSystemStopWithBytesDoesNotCount() {
        var a = FileRules.Attempts()
        for i in 0 ..< 10 { a = a.start(have: Int64(i) * 100)!.stopped(have: Int64(i) * 100 + 50) }
        XCTAssertEqual(a.used, 0)
        a = a.start(have: 1000)!.stopped(have: 1000)
        XCTAssertEqual(a.used, 1)
    }

    /// A killed process leaves its run open: the next start takes it back when it gained bytes, else keeps it.
    func testKilledRunSettlesAtNextStart() {
        let open = FileRules.Attempts().start(have: 0)!.end().start(have: 10)!
        XCTAssertEqual(open.used, 2)
        XCTAssertEqual(open.start(have: 500)!.used, 2)
        XCTAssertEqual(open.start(have: 10)!.used, 3)
        XCTAssertEqual(FileRules.Attempts(used: 4, openAt: 10).start(have: 500)!.used, 4)
        XCTAssertEqual(FileRules.Attempts(used: 5, openAt: 10).start(have: 500)!.used, 5)
        XCTAssertNil(FileRules.Attempts(used: 5, openAt: 10).start(have: 10))
    }

    func testFileURLRule() {
        XCTAssertTrue(FileRules.fileURLOK("https://b2file.pusharmor.com/v1/a"))
        XCTAssertTrue(FileRules.fileURLOK("https://b2file.pusharmor.com:443/v1/a"))
        XCTAssertFalse(FileRules.fileURLOK("http://b2file.pusharmor.com/v1/a"))
        XCTAssertFalse(FileRules.fileURLOK("https://b2file.pusharmor.com:8443/v1/a"))
        XCTAssertFalse(FileRules.fileURLOK("https://user@b2file.pusharmor.com/v1/a"))
        XCTAssertFalse(FileRules.fileURLOK("https://pusharmor.com.example.net/v1/a"))
        XCTAssertFalse(FileRules.fileURLOK("https://example.com/v1/a"))
    }

    // MARK: the file message

    /// The b64url of the 32 ASCII bytes "0123456789abcdef0123456789abcdef" (the plan example).
    static let sample32 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"
    static let ref = FileRef(url: "https://b2file.pusharmor.com/v1/202611230347/3f9a1c5e7b2d4a60/202611230347-0123456789abcdef0123456789abcdef",
                             expires: 1795405632, key: sample32, name: "report (1).pdf",
                             size: 1234567, sha256: "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg")

    func testFileMessageJSON() throws {
        let j = InnerJSON(n: 44, content: .file(Self.ref), id: "dG9wc2VjcmV0aWQxMjM0NQ")
        let text = String(decoding: j.encode(), as: UTF8.self)
        XCTAssertEqual(text, "{\"v\":1,\"n\":44,\"id\":\"dG9wc2VjcmV0aWQxMjM0NQ\",\"show\":true,\"file\":{\"url\":\"https://b2file.pusharmor.com/v1/202611230347/3f9a1c5e7b2d4a60/202611230347-0123456789abcdef0123456789abcdef\",\"expires\":1795405632,\"key\":\"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY\",\"name\":\"report (1).pdf\",\"size\":1234567,\"sha256\":\"n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg\"}}")
        XCTAssertEqual(try InnerJSON.parse(j.encode()), j)
        XCTAssertTrue(MessageContent.file(Self.ref).isContent)
        XCTAssertFalse(ReceivePipeline.isControl(.file(Self.ref)))
    }

    func testFileMessageParse() throws {
        func parse(_ file: String) throws -> MessageContent {
            try InnerJSON.parse(Data(("{\"n\":1,\"show\":true,\"file\":" + file + "}").utf8)).content
        }
        let ok = Self.ref.json
        XCTAssertEqual(try parse(ok), .file(Self.ref))
        // unknown fields are ignored; size 0 is a file
        XCTAssertEqual(try parse(String(ok.dropLast()) + ",\"type\":\"x\"}"), .file(Self.ref))
        let zero = FileRef(url: Self.ref.url, expires: Self.ref.expires, key: Self.ref.key, name: Self.ref.name, size: 0,
                           sha256: Self.ref.sha256)
        XCTAssertEqual(try parse(ok.replacingOccurrences(of: "\"size\":1234567", with: "\"size\":0")), .file(zero))
        let bad = [
            "\"x\"", "1", "[]",
            ok.replacingOccurrences(of: "\"size\":1234567", with: "\"size\":-1"),
            ok.replacingOccurrences(of: "\"size\":1234567", with: "\"size\":1.5"),
            ok.replacingOccurrences(of: "\"size\":1234567", with: "\"size\":01"),
            ok.replacingOccurrences(of: "\"size\":1234567", with: "\"size\":9007199254740992"),
            ok.replacingOccurrences(of: "\"size\":1234567", with: "\"size\":\"5\""),
            ok.replacingOccurrences(of: ",\"size\":1234567", with: ""),
            ok.replacingOccurrences(of: "\"expires\":1795405632", with: "\"expires\":null"),
            ok.replacingOccurrences(of: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY", with: "MDEy"),
            ok.replacingOccurrences(of: "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg", with: "n4bQgYhMfWWaL+qgxVrQFaO_TxsrC4Is0V1sFbDwCgg"),
            ok.replacingOccurrences(of: "\"name\":\"report (1).pdf\"", with: "\"name\":7"),
            ok.replacingOccurrences(of: "\"name\":\"report (1).pdf\"", with: "\"name\":\"" + String(repeating: "a", count: 2049) + "\""),
        ]
        for x in bad { XCTAssertThrowsError(try parse(x), x) }
    }

    // MARK: the steps after a transfer

    func testAfterDownloadChecksStatusBeforeHash() {
        let r = Self.ref
        let size = r.size + 28
        func after(_ s: Int, _ e: String? = nil, size: Int64? = nil, sha: String? = nil, again: Bool = false, now: Int64 = 0) -> FileFlow.DownloadNext {
            FileFlow.afterDownload(status: s, error: e, retryAfter: nil, blobSize: size, blobSHA: sha, ref: r, again: again, nowSec: now)
        }
        XCTAssertEqual(after(200, size: size, sha: r.sha256), .ready)
        XCTAssertEqual(after(206, size: size, sha: r.sha256), .ready)
        XCTAssertEqual(after(200, size: size - 1, sha: r.sha256), .again)
        XCTAssertEqual(after(200, size: size, sha: "x"), .again)
        XCTAssertEqual(after(200, size: size, sha: "x", again: true), .final(.damaged, FileRules.fileDamaged))
        // a 404 or 410 is never "damaged", whatever arrived
        XCTAssertEqual(after(404, size: 10, sha: "x", now: r.expires - 1), .final(.deleted, "Deleted"))
        XCTAssertEqual(after(404, now: r.expires), .final(.expired, "Expired"))
        XCTAssertEqual(after(410, size: 10, sha: "x", again: true), .final(.expired, "Expired"))
        XCTAssertEqual(after(0), .retry(nil))
        XCTAssertEqual(after(502), .retry(nil))
        XCTAssertEqual(after(403), .final(.failed, FileRules.downloadFailed))
    }

    func testAfterUploadResubmitsAtMostTwice() throws {
        func j(_ s: String) -> JSONValue? { try? StrictJSON.parse(Data(s.utf8)) }
        let reply = j("{\"id\":\"202611230347-0123456789abcdef0123456789abcdef\",\"expires\":1795405632,\"url\":\"\(Self.ref.url)\",\"quota\":{}}")
        XCTAssertEqual(FileFlow.afterUpload(status: 201, json: reply, tries: 1),
                       .uploaded(UploadReply(id: "202611230347-0123456789abcdef0123456789abcdef", expires: 1795405632, url: Self.ref.url)))
        XCTAssertEqual(FileFlow.afterUpload(status: 201, json: j("{\"id\":\"a\",\"expires\":1,\"url\":\"https://example.com/a\"}"), tries: 1),
                       .final(.failed, nil))
        XCTAssertEqual(FileFlow.afterUpload(status: 401, json: j("{\"error\":\"clock skew\"}"), tries: 1), .resubmit(nil))
        XCTAssertEqual(FileFlow.afterUpload(status: 0, json: nil, tries: 2), .resubmit(nil))
        XCTAssertEqual(FileFlow.afterUpload(status: 0, json: nil, tries: 3), .final(.failed, nil))
        XCTAssertEqual(FileFlow.afterUpload(status: 401, json: j("{\"error\":\"clock skew\"}"), tries: 3), .final(.failed, nil))
        XCTAssertEqual(FileFlow.afterUpload(status: 429, json: j("{\"error\":\"rate limited\",\"retry_after\":20}"), tries: 1), .resubmit(20))
        XCTAssertEqual(FileFlow.afterUpload(status: 429, json: j("{\"error\":\"file quota\",\"retry_after\":120}"), tries: 1),
                       .final(.quota, "You reached your file limit. Try again in 2 minutes"))
        XCTAssertEqual(FileFlow.afterUpload(status: 401, json: j("{\"error\":\"logged out\"}"), tries: 1), .final(.failed, nil))
        XCTAssertEqual(FileFlow.afterUpload(status: 413, json: nil, tries: 1), .final(.tooLarge, nil))
    }

    func testNameFallbackForImages() {
        XCTAssertEqual(FileFlow.name("???.png", timeSec: 0), "image-19700101-000000.png")
        XCTAssertEqual(FileFlow.name("???.pdf", timeSec: 0), "file-19700101-000000.pdf")
        XCTAssertEqual(FileFlow.name("dir/a b.PDF", timeSec: 0), "a b.PDF")
    }

    // MARK: send and receive over two devices

    func testFileSendAndReceiveStateMachine() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        await n.core.fetchPeers(force: true)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("files-\(UUID().uuidString)")
        let nDir = tmp.appendingPathComponent("n"), xDir = tmp.appendingPathComponent("x")
        try FileManager.default.createDirectory(at: xDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let plain = Data((0 ..< 70_000).map { UInt8($0 % 251) })
        let input = tmp.appendingPathComponent("picked")
        try plain.write(to: input)

        // too large and no room fail before anything is kept
        XCTAssertThrowsError(try n.core.fileSendPrepare(input: input, rawName: "a.bin", to: [], allCount: 1, dir: nDir, free: nil))
        XCTAssertThrowsError(try n.core.fileSendPrepare(input: input, rawName: "a.bin", to: [x.id], allCount: 1, dir: nDir, free: 1)) {
            XCTAssertEqual($0 as? Core.FileSendError, .storage("Not enough storage to send \"a.bin\""))
        }
        XCTAssertEqual(try n.core.store.allFiles().count, 0)

        // prepare: name rule, blob = plaintext + 28 encrypted with the kept key, its sha256
        var f = try n.core.fileSendPrepare(input: input, rawName: "dir/re port?.bin", to: [x.id], allCount: 1, dir: nDir, free: nil)
        XCTAssertEqual(f.name, "re port_.bin")
        XCTAssertEqual(f.state, "uploading")
        let blob = nDir.appendingPathComponent(f.blobName)
        let blobData = try Data(contentsOf: blob)
        XCTAssertEqual(blobData.count, plain.count + 28)
        XCTAssertEqual(f.sha256, FileHash.of(blobData))
        let check = tmp.appendingPathComponent("check")
        try FileCrypto.decrypt(input: blob, output: check, key: B64URL.decode(f.key)!)
        XCTAssertEqual(try Data(contentsOf: check), plain)

        // try 1, signed with PA-FILE1; a transport error resubmits with the same send id, signed again
        let t1 = try XCTUnwrap(try n.core.fileUploadTry(f.id))
        XCTAssertEqual(t1.url.path, "/v1/file")
        XCTAssertEqual(t1.headers["Content-Length"], String(plain.count + 28))
        XCTAssertEqual(t1.headers["PA-ID"], n.id.text)
        XCTAssertEqual(t1.headers["PA-File-SHA256"], f.sha256)
        let signed = FileSig.postBytes(paTime: t1.headers["PA-Time"]!, contentLength: Int64(plain.count + 28),
                                       sha256: f.sha256!, sendId: t1.headers["PA-Send-ID"]!)
        XCTAssertTrue(Signatures.verify(B64URL.decode(t1.headers["PA-Sig"]!)!, data: signed, publicKey: n.keys.signer.publicKey))
        XCTAssertEqual(try n.core.fileUploadEnded(f.id, status: 0, body: nil, epoch: nil), .resubmit(nil))
        let t2 = try XCTUnwrap(try n.core.fileUploadTry(f.id))
        XCTAssertEqual(t2.headers["PA-Send-ID"], t1.headers["PA-Send-ID"])
        let reply = "{\"id\":\"209611230347-0123456789abcdef0123456789abcdef\",\"expires\":4000000000,\"url\":\"https://b2file.pusharmor.com/v1/209611230347/3f9a1c5e7b2d4a60/209611230347-0123456789abcdef0123456789abcdef\",\"quota\":{}}"
        guard case .uploaded? = try n.core.fileUploadEnded(f.id, status: 201, body: Data(reply.utf8), epoch: nil) else {
            return XCTFail("not uploaded")
        }
        f = try XCTUnwrap(try n.core.store.file(f.id))
        XCTAssertEqual(f.state, "uploaded")
        XCTAssertEqual(f.tries, 2)

        // the file message goes to the device; the blob goes; the sent row is the file row, named
        let rep = try await n.core.fileSendMessage(f.id, dir: nDir)
        XCTAssertTrue(rep.allSent)
        // a second caller (app open, a session event) sends nothing more
        do {
            _ = try await n.core.fileSendMessage(f.id, dir: nDir)
            XCTFail("sent twice")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: blob.path))
        f = try XCTUnwrap(try n.core.store.file(f.id))
        XCTAssertEqual(f.state, "sent")
        let sentRow = try XCTUnwrap(try n.core.store.historyRow(f.historyRowid!))
        XCTAssertEqual(sentRow.type, "file")
        XCTAssertEqual(sentRow.content, f.name)
        XCTAssertEqual(sentRow.msgId, f.msgId)

        // receive: a file History row with the cleaned name, and a pending files record
        let pushed = w.take(x.id)
        XCTAssertEqual(pushed.count, 1)
        let r = await x.core.receive(pushed[0], mode: .nse)
        let fid = try XCTUnwrap(r.fileId)
        XCTAssertTrue(r.newMessage)
        let row = try XCTUnwrap(try x.core.store.historyRow(r.rowid!))
        XCTAssertEqual(row.type, "file")
        XCTAssertEqual(row.content, "re port_.bin")
        var g = try XCTUnwrap(try x.core.store.file(fid))
        XCTAssertEqual(g.state, "pending")
        XCTAssertEqual(g.name, "re port_.bin")
        XCTAssertEqual(g.size, Int64(plain.count))
        XCTAssertEqual(g.sha256, f.sha256)
        // a Worker retry duplicate adds no second record
        _ = await x.core.receive(pushed[0], mode: .nse)
        XCTAssertEqual(try x.core.store.allFiles().count, 1)

        // catch-up follows the picker for the current network
        try x.core.store.setSetting(FileSettingKey.wifi, "0")
        XCTAssertEqual(try x.core.fileCatchUp(network: .wifi, lowData: false, free: nil).map { $0.id }, [])
        XCTAssertEqual(try x.core.fileCatchUp(network: .mobile, lowData: true, free: nil).map { $0.id }, [])
        XCTAssertEqual(try x.core.fileCatchUp(network: .mobile, lowData: false, free: nil).map { $0.id }, [fid])
        try x.core.store.setSetting(FileSettingKey.wifi, nil)
        XCTAssertEqual(try x.core.fileCatchUp(network: .wifi, lowData: false, free: nil).map { $0.id }, [fid])

        // download: the blob arrives, its status and hash are checked, then the decrypt
        XCTAssertTrue(try x.core.fileDownloadStarts(fid, task: "s 1"))
        XCTAssertEqual(try x.core.store.file(fid)?.state, "loading")
        try blobData.write(to: xDir.appendingPathComponent(g.blobName))
        try x.core.fileTaskEnded(fid, task: "s 1", status: 200, body: nil, blobArrived: true)
        XCTAssertEqual(try x.core.fileCheck(fid, dir: xDir), .ready)
        // a second or stale completion never moves a ready file back, and a ready file takes no new task
        try x.core.fileTaskEnded(fid, task: "s 1", status: 0, body: nil, blobArrived: false)
        XCTAssertEqual(try x.core.store.file(fid)?.state, "ready")
        XCTAssertFalse(try x.core.fileDownloadStarts(fid, task: "s 2"))
        XCTAssertEqual(try x.core.fileDecrypt(fid, dir: xDir, freeMemory: 1, manual: false), .noMemory)
        g = try XCTUnwrap(try x.core.store.file(fid))
        XCTAssertEqual(g.error, "Not enough memory to decrypt")
        XCTAssertNil(g.decryptMark)
        // a cancelled decrypt (History left) leaves the file ready with no error
        XCTAssertEqual(try x.core.fileDecrypt(fid, dir: xDir, freeMemory: nil, manual: true, cancelled: { true }), .cancelled)
        g = try XCTUnwrap(try x.core.store.file(fid))
        XCTAssertEqual(g.state, "ready")
        XCTAssertNil(g.code)
        XCTAssertNil(g.decryptMark)
        // a decrypt that cannot run (its folder is taken by a file) keeps the blob and shows the
        // error with a Decrypt button; it is not tried again by itself
        let taken = xDir.appendingPathComponent(g.plainDirName)
        try? FileManager.default.removeItem(at: taken)
        try Data().write(to: taken)
        XCTAssertEqual(try x.core.fileDecrypt(fid, dir: xDir, freeMemory: nil, manual: true), .failed(FileUi.openFailed))
        g = try XCTUnwrap(try x.core.store.file(fid))
        XCTAssertEqual(g.state, "ready")
        XCTAssertEqual(g.code, "failed")
        XCTAssertNil(g.decryptMark)
        XCTAssertTrue(FileManager.default.fileExists(atPath: xDir.appendingPathComponent(g.blobName).path))
        XCTAssertEqual(FileUi.status(g, plainThere: false, received: nil, nowSec: 0), .decryptFailed(text: FileUi.openFailed))
        try FileManager.default.removeItem(at: taken)
        guard case .done(let out) = try x.core.fileDecrypt(fid, dir: xDir, freeMemory: 1, manual: true) else { return XCTFail("decrypt") }
        XCTAssertEqual(out.lastPathComponent, "re port_.bin")
        XCTAssertEqual(try Data(contentsOf: out), plain)
        g = try XCTUnwrap(try x.core.store.file(fid))
        XCTAssertEqual(g.state, "done")
        XCTAssertNil(g.decryptMark)
        XCTAssertFalse(FileManager.default.fileExists(atPath: xDir.appendingPathComponent(g.blobName).path))

        // a decrypt mark left at app start (the app closed during it) shows the memory error
        g.decryptMark = 5
        try x.core.store.saveFile(g)
        try x.core.settleDecryptMarks()
        g = try XCTUnwrap(try x.core.store.file(fid))
        XCTAssertNil(g.decryptMark)
        XCTAssertEqual(g.code, "memory")

        // the History row goes: the record and its local files go too
        try x.core.store.db.exec("DELETE FROM history WHERE rowid = ?", [.int(r.rowid!)])
        try x.core.pruneFiles(dir: xDir)
        XCTAssertNil(try x.core.store.file(fid))
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path))
    }

    func testDownloadAttemptsDamagedAndStorage() throws {
        let w = FakeWorker(), clock = TestClock()
        let x = try Device(worker: w, clock: clock, name: "Xdev")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("files-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        func add(_ size: Int64 = 1000) throws -> Int64 {
            var ref = Self.ref
            ref = FileRef(url: ref.url, expires: 4_000_000_000, key: ref.key, name: ref.name, size: size, sha256: ref.sha256)
            return try x.core.store.addFile(Core.receivedFile(ref, historyRowid: 1, now: clock.now))
        }

        // five automatic attempts, then "Download failed"; the Download button still starts
        let a = try add()
        for i in 0 ..< 5 {
            XCTAssertTrue(try x.core.fileDownloadStarts(a, task: "s \(i)"), "\(i)")
            try x.core.fileTaskEnded(a, task: "s \(i)", status: 502, body: nil, blobArrived: false)
            XCTAssertEqual(try x.core.fileCheck(a, dir: dir), .retry(nil))
        }
        XCTAssertFalse(try x.core.fileDownloadStarts(a, task: "s 5"))
        XCTAssertEqual(try x.core.store.file(a)?.error, "Download failed")
        XCTAssertTrue(try x.core.fileDownloadStarts(a, task: "s 6", manual: true))

        // a blob that fails its check is downloaded once more, then is damaged
        let d = try add()
        for (i, want) in [FileFlow.DownloadNext.again, .final(.damaged, FileRules.fileDamaged)].enumerated() {
            XCTAssertTrue(try x.core.fileDownloadStarts(d, task: "d \(i)"))
            let rec = try XCTUnwrap(try x.core.store.file(d))
            try Data(count: 1028).write(to: dir.appendingPathComponent(rec.blobName))
            try x.core.fileTaskEnded(d, task: "d \(i)", status: 200, body: nil, blobArrived: true)
            XCTAssertEqual(try x.core.fileCheck(d, dir: dir), want)
        }
        XCTAssertEqual(try x.core.store.file(d)?.state, "failed")

        // a 410 reply is "Expired", read from the reply body
        let e = try add()
        XCTAssertTrue(try x.core.fileDownloadStarts(e, task: "e"))
        try x.core.fileTaskEnded(e, task: "e", status: 410, body: Data("{\"error\":\"expired\"}".utf8), blobArrived: false)
        XCTAssertEqual(try x.core.fileCheck(e, dir: dir), .final(.expired, "Expired"))

        // no room: the storage error, final, and no download starts
        let s = try add(50_000_000)
        XCTAssertEqual(try x.core.fileCatchUp(network: .wifi, lowData: false, free: 100_000_000).map { $0.id }, [])
        let rec = try XCTUnwrap(try x.core.store.file(s))
        XCTAssertEqual(rec.state, "failed")
        XCTAssertEqual(rec.error, "Not enough storage to download \"report (1).pdf\"")
    }

    func testOneTaskPerFileManualMarkAndKeptBytes() throws {
        let w = FakeWorker(), clock = TestClock()
        let x = try Device(worker: w, clock: clock, name: "Xdev")
        let ref = FileRef(url: Self.ref.url, expires: 4_000_000_000, key: Self.ref.key, name: "a.bin", size: 1000,
                          sha256: Self.ref.sha256)
        let id = try x.core.store.addFile(Core.receivedFile(ref, historyRowid: 1, now: clock.now))
        XCTAssertTrue(try x.core.fileDownloadStarts(id, task: "t 1"))
        // loading: no second task, not even from the button
        XCTAssertFalse(try x.core.fileDownloadStarts(id, task: "t 2"))
        XCTAssertFalse(try x.core.fileDownloadStarts(id, task: "t 2", manual: true))
        // only the running task's completion applies
        try x.core.fileTaskEnded(id, task: "t 9", status: 0, body: nil, blobArrived: false)
        XCTAssertEqual(try x.core.store.file(id)?.state, "loading")
        // a run that kept bytes in resume data is not an attempt; the kept bytes carry to the next run
        try x.core.fileTaskEnded(id, task: "t 1", status: 0, body: nil, blobArrived: false, received: 400, resumable: true)
        var f = try XCTUnwrap(try x.core.store.file(id))
        XCTAssertEqual(f.state, "pending")
        XCTAssertEqual(f.attempts, 0)
        XCTAssertEqual(f.have, 400)
        XCTAssertTrue(try x.core.fileDownloadStarts(id, task: "t 3"))
        try x.core.fileTaskEnded(id, task: "t 3", status: 0, body: nil, blobArrived: false, received: 0, resumable: true)
        f = try XCTUnwrap(try x.core.store.file(id))
        XCTAssertEqual(f.attempts, 1)
        XCTAssertEqual(f.have, 400)
        // the button mark stays for the later automatic tries
        XCTAssertTrue(try x.core.fileDownloadStarts(id, task: "t 4", manual: true))
        try x.core.fileTaskEnded(id, task: "t 4", status: 0, body: nil, blobArrived: false)
        f = try XCTUnwrap(try x.core.store.file(id))
        XCTAssertTrue(f.manual)
        XCTAssertEqual(f.have, 0)
        // a take-over keeps the bytes in resume data and uses no attempt
        let used = f.attempts
        XCTAssertTrue(try x.core.fileDownloadStarts(id, task: "t 5"))
        try x.core.store.fileTaskEnded(id, task: "t 5", status: 0, body: nil, blobArrived: false, received: 0, resumable: true,
                                       notCounted: true)
        f = try XCTUnwrap(try x.core.store.file(id))
        XCTAssertEqual(f.attempts, used)
        XCTAssertEqual(f.state, "pending")
    }

    func testPruneKeepsHeldCompletions() throws {
        let w = FakeWorker(), clock = TestClock()
        let x = try Device(worker: w, clock: clock, name: "Xdev")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("files-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        for n in ["held-a.json", "claimed-b.json", "in-99.blob"] { try Data([1]).write(to: dir.appendingPathComponent(n)) }
        try x.core.pruneFiles(dir: dir)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted(), ["claimed-b.json", "held-a.json"])
    }

    func testExpiredOnArrivalHasGenericBannerAndNoDownload() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        await n.core.fetchPeers(force: true)
        let old = FileRef(url: Self.ref.url, expires: clock.now - 1, key: Self.ref.key, name: "a.bin", size: 10, sha256: Self.ref.sha256)
        _ = try await n.core.sendContent(.file(old), rowType: "unknown", rowContent: "file", msgId: InnerJSON.newId(), to: [x.id], allCount: 1)
        let pushed = w.take(x.id)
        XCTAssertEqual(pushed.count, 1)
        let r = await x.core.receive(pushed[0], mode: .nse)
        XCTAssertEqual(r.banner?.body, S.fallback)
        let f = try XCTUnwrap(try x.core.store.file(r.fileId!))
        XCTAssertEqual(f.state, "failed")
        XCTAssertEqual(f.error, "Expired")
        XCTAssertEqual(try x.core.fileCatchUp(network: .wifi, lowData: false, free: nil).count, 0)
    }

    func testLogoutWipesFilesAndSettleSends() throws {
        final class Hooks: PlatformHooks {
            var wiped: [[String]] = []
            func wipeKeys() {}
            func removeLockedInbox() {}
            func removeDeliveredNotifications() {}
            func isProtectedDataLocked() -> Bool { false }
            func wipeFiles(tasks: [String]) { wiped.append(tasks) }
        }
        let w = FakeWorker(), clock = TestClock()
        let x = try Device(worker: w, clock: clock, name: "Xdev")
        let hooks = Hooks()
        x.core.hooks = hooks
        let id = try x.core.store.addFile(Core.receivedFile(Self.ref, historyRowid: 1, now: clock.now))
        XCTAssertTrue(try x.core.fileDownloadStarts(id, task: "s 7"))
        var out = FileRecord(dir: .outgoing, key: Self.ref.key, name: "b.bin", size: 1, state: "sending", created: clock.now)
        out.id = try x.core.store.addFile(out)
        try x.core.settleSends(except: [out.id])
        XCTAssertEqual(try x.core.store.file(out.id)?.state, "sending")
        try x.core.settleSends()
        XCTAssertEqual(try x.core.store.file(out.id)?.state, "failed")
        try x.core.logoutLocal()
        XCTAssertEqual(try x.core.store.allFiles().count, 0)
        XCTAssertEqual(hooks.wiped, [["s 7"]])
    }
}
