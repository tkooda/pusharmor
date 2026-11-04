import XCTest
@testable import PushArmor

/// The four fingerprint cells stay on one row at every text size: they shrink to fit the width.
final class FingerprintLayoutTests: XCTestCase {
    private func rowWidth(_ glyph: CGFloat, count: Int = 4) -> CGFloat {
        CGFloat(count) * glyph * 66 / 40 + CGFloat(count - 1) * 10
    }

    func testDefaultSizeIsKeptWhenItFits() {
        XCTAssertEqual(FingerprintPlate.cellSize(scaled: 40, width: 400, count: 4), 40)
    }

    func testLargestTextSizesShrinkToOneRow() {
        // accessibility text sizes scale the 40 pt cell up to about 3x; narrow phones, iPad split view
        for scaled in [40, 53, 64, 80, 100, 124] as [CGFloat] {
            for width in [120, 200, 240, 290, 320, 375] as [CGFloat] {
                let size = FingerprintPlate.cellSize(scaled: scaled, width: width, count: 4)
                XCTAssertLessThanOrEqual(rowWidth(size), width + 0.001, "scaled \(scaled) width \(width)")
                XCTAssertLessThanOrEqual(size, 64)
                XCTAssertGreaterThan(size, 0)
            }
        }
    }

    func testBeforeTheWidthIsKnownTheScaledSizeIsCapped() {
        XCTAssertEqual(FingerprintPlate.cellSize(scaled: 100, width: 0, count: 4), 64)
    }

    func testThePlateHasNoTwoRowGrid() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/Brand.swift")
        let brand = try String(contentsOf: url, encoding: .utf8)
        let start = try XCTUnwrap(brand.range(of: "struct FingerprintPlate"))
        let end = try XCTUnwrap(brand.range(of: "// MARK: illustrations"))
        let plate = brand[start.lowerBound..<end.lowerBound]
        XCTAssertFalse(plate.contains("GridRow"))
        XCTAssertFalse(plate.contains("ViewThatFits"))
        XCTAssertTrue(plate.contains(".lineLimit(1)"))
    }
}
