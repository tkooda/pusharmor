import Foundation
#if canImport(Compression)
import Compression
#elseif canImport(CZlib)
import CZlib
#endif

/// deflate-raw (RFC 1951) both ways. Apple: Compression framework, COMPRESSION_ZLIB is raw
/// RFC 1951. Linux (tests only): system zlib with windowBits -15.
public enum Deflate {
    public static let inflateCap = 16 * 1024

    public enum Failure: Error { case setup, corrupt, tooLarge, truncated, trailing }

    public static func deflateRaw(_ input: Data) throws -> Data {
        try run(encode: true, input: input, cap: Int.max)
    }

    /// Streaming inflate with a hard output cap; rejects corrupt, truncated or trailing data.
    public static func inflateRaw(_ input: Data, cap: Int = inflateCap) throws -> Data {
        try run(encode: false, input: input, cap: cap)
    }

    private static let chunk = 4096

#if canImport(Compression)
    private static func run(encode: Bool, input: Data, cap: Int) throws -> Data {
        let sp = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { sp.deallocate() }
        let op = encode ? COMPRESSION_STREAM_ENCODE : COMPRESSION_STREAM_DECODE
        guard compression_stream_init(sp, op, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            throw Failure.setup
        }
        defer { compression_stream_destroy(sp) }
        let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
        defer { dst.deallocate() }
        var out = Data()
        let src = [UInt8](input) + [0] // never an empty buffer; the extra byte is not counted
        try src.withUnsafeBufferPointer { buf in
            sp.pointee.src_ptr = buf.baseAddress!
            sp.pointee.src_size = input.count
            while true {
                sp.pointee.dst_ptr = dst
                sp.pointee.dst_size = chunk
                let st = compression_stream_process(sp, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                if st == COMPRESSION_STATUS_ERROR { throw Failure.corrupt }
                let produced = chunk - sp.pointee.dst_size
                out.append(dst, count: produced)
                if out.count > cap { throw Failure.tooLarge }
                if st == COMPRESSION_STATUS_END { break }
                if produced == 0 && sp.pointee.src_size == 0 { throw Failure.truncated }
            }
            if !encode && sp.pointee.src_size != 0 { throw Failure.trailing }
        }
        return out
    }
#elseif canImport(CZlib)
    private static func run(encode: Bool, input: Data, cap: Int) throws -> Data {
        var s = z_stream()
        let size = Int32(MemoryLayout<z_stream>.size)
        let rc = encode
            ? deflateInit2_(&s, Z_DEFAULT_COMPRESSION, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY, zlibVersion(), size)
            : inflateInit2_(&s, -15, zlibVersion(), size)
        guard rc == Z_OK else { throw Failure.setup }
        defer { if encode { deflateEnd(&s) } else { inflateEnd(&s) } }
        var src = [UInt8](input) + [0]
        var dst = [UInt8](repeating: 0, count: chunk)
        var out = Data()
        try src.withUnsafeMutableBufferPointer { sb in
            s.next_in = sb.baseAddress
            s.avail_in = UInt32(input.count)
            while true {
                let st: Int32 = dst.withUnsafeMutableBufferPointer { db in
                    s.next_out = db.baseAddress
                    s.avail_out = UInt32(chunk)
                    return encode ? deflate(&s, Z_FINISH) : inflate(&s, Z_FINISH)
                }
                let produced = chunk - Int(s.avail_out)
                out.append(contentsOf: dst[0 ..< produced])
                if out.count > cap { throw Failure.tooLarge }
                if st == Z_STREAM_END { break }
                if st == Z_DATA_ERROR || st == Z_STREAM_ERROR || st == Z_MEM_ERROR || st == Z_NEED_DICT {
                    throw Failure.corrupt
                }
                if st == Z_BUF_ERROR && produced == 0 { throw Failure.truncated }
            }
            if !encode && s.avail_in != 0 { throw Failure.trailing }
        }
        return out
    }
#endif
}
