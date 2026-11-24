import Foundation
import COpenSSL

/// File blob crypto through OpenSSL libcrypto: AES-256-GCM, one 32-byte key and one
/// 12-byte nonce per file, no AAD, one tag, never chunked on the wire.
/// blob = nonce (12) || ciphertext || tag (16), so blob size = file size + 28.
/// Both directions stream file to file through one fixed buffer (constant memory).
/// The output appears only complete: it is written to a private temp file in the
/// output directory and renamed into place at the end. Decrypt renames only after
/// the tag passes; on any failure the temp file is deleted and the output is untouched.
public enum FileCrypto {
    public static let keySize = 32
    public static let nonceSize = 12
    public static let tagSize = 16
    public static let overhead = nonceSize + tagSize
    static let chunkSize = 64 * 1024

    public enum Failure: Error, Equatable {
        case badKey
        /// The blob is shorter than nonce + tag.
        case tooShort
        /// The GCM tag does not match: wrong key, or the blob was changed.
        case tagMismatch
        case engine
        case io(String)
        /// `cancelled` returned true: no output is left.
        case cancelled
    }

    /// Encrypts the file at `input` into a blob at `output` with a fresh random nonce.
    /// `cancelled` is asked before each chunk.
    public static func encrypt(input: URL, output: URL, key: Data, cancelled: () -> Bool = { false }) throws {
        var g = SystemRandomNumberGenerator()
        try encrypt(input: input, output: output, key: key,
                    nonce: Data((0..<nonceSize).map { _ in UInt8.random(in: 0...255, using: &g) }), cancelled: cancelled)
    }

    /// Fixed nonce: known-answer tests only.
    static func encrypt(input: URL, output: URL, key: Data, nonce: Data, cancelled: () -> Bool = { false }) throws {
        guard key.count == keySize, nonce.count == nonceSize else { throw Failure.badKey }
        let inFd = try openRead(input)
        defer { close(inFd) }
        try writeAtomically(output) { outFd in
            let ctx = try Cipher(encrypt: true, key: key, nonce: nonce)
            try writeAll(outFd, [UInt8](nonce))
            var buf = [UInt8](repeating: 0, count: chunkSize)
            var out = [UInt8](repeating: 0, count: chunkSize)
            defer { wipe(&buf); wipe(&out) }
            while true {
                if cancelled() { throw Failure.cancelled }
                let n = try readSome(inFd, &buf, chunkSize)
                if n == 0 { break }
                try ctx.update(buf, n, &out)
                try writeAll(outFd, out, n)
            }
            try ctx.finish()
            try writeAll(outFd, try ctx.tag())
        }
    }

    /// Decrypts the blob at `input` into the file at `output`. Throws `tagMismatch`
    /// (and leaves no output) when the blob does not verify. `cancelled` is asked before each chunk.
    public static func decrypt(input: URL, output: URL, key: Data, cancelled: () -> Bool = { false }) throws {
        guard key.count == keySize else { throw Failure.badKey }
        let inFd = try openRead(input)
        defer { close(inFd) }
        var st = stat()
        guard fstat(inFd, &st) == 0 else { throw Failure.io("stat: \(errnoText())") }
        let blobSize = Int64(st.st_size)
        guard blobSize >= Int64(overhead) else { throw Failure.tooShort }
        var nonce = [UInt8](repeating: 0, count: nonceSize)
        try readExactly(inFd, &nonce, nonceSize)
        try writeAtomically(output) { outFd in
            let ctx = try Cipher(encrypt: false, key: key, nonce: Data(nonce))
            var buf = [UInt8](repeating: 0, count: chunkSize)
            var out = [UInt8](repeating: 0, count: chunkSize)
            defer { wipe(&buf); wipe(&out) }
            var left = blobSize - Int64(overhead)
            while left > 0 {
                if cancelled() { throw Failure.cancelled }
                let want = Int(min(Int64(chunkSize), left))
                try readExactly(inFd, &buf, want)
                try ctx.update(buf, want, &out)
                try writeAll(outFd, out, want)
                left -= Int64(want)
            }
            var tag = [UInt8](repeating: 0, count: tagSize)
            try readExactly(inFd, &tag, tagSize)
            try ctx.setTag(tag)
            // The tag check: nothing is moved into place unless this passes.
            guard ctx.finishVerified() else { throw Failure.tagMismatch }
        }
    }

    // MARK: OpenSSL EVP

    private final class Cipher {
        let ctx: OpaquePointer
        let encrypt: Bool

        init(encrypt: Bool, key: Data, nonce: Data) throws {
            guard let c = EVP_CIPHER_CTX_new() else { throw Failure.engine }
            ctx = c
            self.encrypt = encrypt
            // From here on deinit frees ctx, also when init throws.
            let cipherOk = encrypt
                ? EVP_EncryptInit_ex(c, EVP_aes_256_gcm(), nil, nil, nil)
                : EVP_DecryptInit_ex(c, EVP_aes_256_gcm(), nil, nil, nil)
            guard cipherOk == 1 else { throw Failure.engine }
            // The IV length is set explicitly (EVP_CTRL_GCM_SET_IVLEN), not left to the default.
            guard EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_SET_IVLEN, Int32(FileCrypto.nonceSize), nil) == 1 else {
                throw Failure.engine
            }
            let ok = key.withUnsafeBytes { k in
                nonce.withUnsafeBytes { n in
                    let kp = k.bindMemory(to: UInt8.self).baseAddress
                    let np = n.bindMemory(to: UInt8.self).baseAddress
                    return encrypt
                        ? EVP_EncryptInit_ex(c, nil, nil, kp, np)
                        : EVP_DecryptInit_ex(c, nil, nil, kp, np)
                }
            }
            guard ok == 1 else { throw Failure.engine }
        }

        deinit { EVP_CIPHER_CTX_free(ctx) }

        func update(_ input: [UInt8], _ n: Int, _ out: inout [UInt8]) throws {
            var outLen: Int32 = 0
            let ok = out.withUnsafeMutableBufferPointer { o in
                input.withUnsafeBufferPointer { i in
                    encrypt
                        ? EVP_EncryptUpdate(ctx, o.baseAddress, &outLen, i.baseAddress, Int32(n))
                        : EVP_DecryptUpdate(ctx, o.baseAddress, &outLen, i.baseAddress, Int32(n))
                }
            }
            // GCM is a stream mode: each update returns exactly its input length.
            guard ok == 1, Int(outLen) == n else { throw Failure.engine }
        }

        func finish() throws {
            var outLen: Int32 = 0
            var out = [UInt8](repeating: 0, count: 16)
            guard EVP_EncryptFinal_ex(ctx, &out, &outLen) == 1, outLen == 0 else { throw Failure.engine }
        }

        func tag() throws -> [UInt8] {
            var t = [UInt8](repeating: 0, count: FileCrypto.tagSize)
            guard EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_GET_TAG, Int32(FileCrypto.tagSize), &t) == 1 else {
                throw Failure.engine
            }
            return t
        }

        func setTag(_ tag: [UInt8]) throws {
            var t = tag
            guard EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_TAG, Int32(FileCrypto.tagSize), &t) == 1 else {
                throw Failure.engine
            }
        }

        /// EVP_DecryptFinal_ex returns 1 only when the tag matches.
        func finishVerified() -> Bool {
            var outLen: Int32 = 0
            var out = [UInt8](repeating: 0, count: 16)
            return EVP_DecryptFinal_ex(ctx, &out, &outLen) == 1 && outLen == 0
        }
    }

    // MARK: files (POSIX, one reused buffer per direction)

    /// Runs `body` on a new private (0600) temp file next to `output`, then syncs it and
    /// renames it to `output`. If `body` throws, the temp file is deleted and `output`
    /// is not touched.
    private static func writeAtomically(_ output: URL, _ body: (Int32) throws -> Void) throws {
        let dir = output.deletingLastPathComponent()
        let tmp = dir.appendingPathComponent(".\(output.lastPathComponent).\(UUID().uuidString).part")
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure.io("create: \(errnoText())") }
        var done = false
        defer {
            if !done { unlink(tmp.path) }
        }
        do {
            try body(fd)
            guard fsync(fd) == 0 else { throw Failure.io("sync: \(errnoText())") }
        } catch {
            close(fd)
            throw error
        }
        guard close(fd) == 0 else { throw Failure.io("close: \(errnoText())") }
        guard rename(tmp.path, output.path) == 0 else { throw Failure.io("rename: \(errnoText())") }
        done = true
    }

    private static func openRead(_ url: URL) throws -> Int32 {
        let fd = open(url.path, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.io("open: \(errnoText())") }
        return fd
    }

    /// Reads up to `max` bytes; 0 means end of file.
    private static func readSome(_ fd: Int32, _ buf: inout [UInt8], _ max: Int) throws -> Int {
        while true {
            let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, max) }
            if n >= 0 { return n }
            if errno != EINTR { throw Failure.io("read: \(errnoText())") }
        }
    }

    private static func readExactly(_ fd: Int32, _ buf: inout [UInt8], _ count: Int) throws {
        var got = 0
        while got < count {
            let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress! + got, count - got) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw Failure.io(n == 0 ? "read: file ended early" : "read: \(errnoText())") }
            got += n
        }
    }

    private static func writeAll(_ fd: Int32, _ buf: [UInt8], _ count: Int? = nil) throws {
        let total = count ?? buf.count
        var sent = 0
        while sent < total {
            let n = buf.withUnsafeBytes { write(fd, $0.baseAddress! + sent, total - sent) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw Failure.io("write: \(errnoText())") }
            sent += n
        }
    }

    /// Zeroes a buffer that held plaintext (memset_s is not optimized away).
    private static func wipe(_ buf: inout [UInt8]) {
        buf.withUnsafeMutableBytes { b in
            if let p = b.baseAddress { _ = memset_s(p, b.count, 0, b.count) }
        }
    }

    private static func errnoText() -> String { String(cString: strerror(errno)) }
}
