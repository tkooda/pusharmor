import XCTest
@testable import PushArmorCore

final class EncodingTests: XCTestCase {
    func testB64URLEncodeRFC4648() {
        // RFC 4648 section 10 vectors, URL alphabet, no padding
        let cases = ["": "", "f": "Zg", "fo": "Zm8", "foo": "Zm9v", "foob": "Zm9vYg", "fooba": "Zm9vYmE", "foobar": "Zm9vYmFy"]
        for (i, o) in cases {
            XCTAssertEqual(B64URL.encode(Data(i.utf8)), o)
            XCTAssertEqual(B64URL.decode(o), Data(i.utf8))
        }
        XCTAssertEqual(B64URL.encode(Data([0xfb, 0xff, 0xbf])), "-_-_")
        XCTAssertEqual(B64URL.decode("-_-_"), Data([0xfb, 0xff, 0xbf]))
    }

    func testB64URLStrictRejects() {
        for bad in ["Zg==", "Zg=", "Zm9v+A", "Zm9v/A", "Z", "Zm9vY", "Zh", "Zm9", "Zm8 ", "Zm\n8", "\u{00e9}AAA"] {
            if bad == "Zm9" { continue }
            XCTAssertNil(B64URL.decode(bad), bad)
        }
        // "Zm9" decodes to "fo" only if the spare bits are 0: "Zm9" -> 'Z','m','9' (9 = 61, low 2 bits 01) -> reject
        XCTAssertNil(B64URL.decode("Zm9"))
        XCTAssertNotNil(B64URL.decode("Zm8"))
        // 65-byte key = 87 chars with 2 spare bits that must be 0
        let key = Data([4] + [UInt8](repeating: 0xff, count: 64))
        let s = B64URL.encode(key)
        XCTAssertEqual(s.count, 87)
        XCTAssertEqual(B64URL.decode(s), key)
        var bad = Array(s.utf8)
        bad[86] = UInt8(ascii: "_") // last char with nonzero spare bits
        XCTAssertNil(B64URL.decode(String(decoding: bad, as: UTF8.self)))
    }

    func testHexRoundTrip() {
        XCTAssertEqual(Bytes.hex(Data([0, 0xab, 0xff])), "00abff")
        XCTAssertEqual(Bytes.fromHex("00ABff"), Data([0, 0xab, 0xff]))
        XCTAssertNil(Bytes.fromHex("0"))
        XCTAssertNil(Bytes.fromHex("zz"))
    }

    func testCrockford() {
        // first 20 bits of d8614f: 11011 00001 10000 10100 -> 27 1 16 20 -> V 1 G M
        XCTAssertEqual(Crockford.encodePrefix(hex("d8614f"), chars: 4), "V1GM")
        XCTAssertEqual(Crockford.encodePrefix(Data([0, 0, 0]), chars: 4), "0000")
        XCTAssertEqual(Crockford.encodePrefix(Data([0xff, 0xff, 0xff]), chars: 4), "ZZZZ")
    }

    func testStrictJSON() throws {
        XCTAssertEqual(try StrictJSON.parse(Data("{\"a\":[1,true,null,\"x\\u00e9\\ud83d\\ude00\"]}".utf8)),
                       .object([("a", .array([.number("1"), .bool(true), .null, .string("x\u{e9}\u{1F600}")]))]))
        for bad in ["{\"a\":1,\"a\":2}", "{\"a\":{\"b\":1,\"b\":1}}", "{\"a\":01}", "{\"a\":1.}", "{\"a\":\"\\ud800\"}",
                    "{\"a\":1}x", "{\"a\":\"\u{01}\"}", "[1,]", "{\"a\" 1}", "{\"a\":-}"] {
            XCTAssertThrowsError(try StrictJSON.parse(Data(bad.utf8)), bad)
        }
        XCTAssertThrowsError(try StrictJSON.parse(Data([0x22, 0xff, 0x22])))
        XCTAssertEqual(StrictJSON.quote("a\"b\\c\n\u{01}\u{e9}"), "\"a\\\"b\\\\c\\n\\u0001\u{e9}\"")
    }

    func testCounterToken() {
        XCTAssertEqual(Counter.parse("1"), 1)
        XCTAssertEqual(Counter.parse("9007199254740991"), 9007199254740991)
        for bad in ["0", "01", "1.0", "1e0", "-1", "9007199254740992", "", "+1", "18446744073709551616"] {
            XCTAssertNil(Counter.parse(bad), bad)
        }
    }

    func testDeflateKnownBytes() throws {
        // raw deflate (zlib level 9, wbits -15) of {"n":42,"url":"https://example.com/a"}
        let d = hex("ab56ca53b23231d2512a2dca51b252ca28292928b6d2d74fad48cc2dc849d54bcecfd54f54aa0500")
        XCTAssertEqual(try Deflate.inflateRaw(d), Data("{\"n\":42,\"url\":\"https://example.com/a\"}".utf8))
        let x = Data("hello hello hello hello".utf8)
        XCTAssertEqual(try Deflate.inflateRaw(try Deflate.deflateRaw(x)), x)
        XCTAssertEqual(try Deflate.inflateRaw(try Deflate.deflateRaw(Data())), Data())
    }

    func testInflateCapTruncationTrailing() throws {
        let big = try Deflate.deflateRaw(Data(count: Deflate.inflateCap + 1))
        XCTAssertThrowsError(try Deflate.inflateRaw(big))
        let ok = try Deflate.deflateRaw(Data(count: Deflate.inflateCap))
        XCTAssertEqual(try Deflate.inflateRaw(ok).count, Deflate.inflateCap)
        let d = hex("ab56ca53b23231d2512a2dca51b252ca28292928b6d2d74fad48cc2dc849d54bcecfd54f54aa0500")
        XCTAssertThrowsError(try Deflate.inflateRaw(d.prefix(d.count - 3)))
        XCTAssertThrowsError(try Deflate.inflateRaw(d + Data([0])))
        XCTAssertThrowsError(try Deflate.inflateRaw(Data([0xff, 0xff, 0xff])))
    }

    func testDialStringKeepsLeadingPlus() {
        XCTAssertEqual(DialString.make("+49 30 1234567"), "+4930" + "1234567")
        XCTAssertEqual(DialString.make(" (030) 123-4567 "), "0301234567")
        XCTAssertEqual(DialString.make("tel:+1 (555) 010-9999"), "+15550109999")
        XCTAssertEqual(DialString.make("555 12+34"), "5551234")
    }
}
