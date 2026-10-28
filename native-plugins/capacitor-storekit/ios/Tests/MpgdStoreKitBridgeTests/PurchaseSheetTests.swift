import XCTest
@testable import MpgdStoreKitBridge

/// One `open` at most and exactly one terminal fact per purchase sheet.
final class PurchaseSheetTests: XCTestCase {
    private var facts: [String] = []

    private func sheet(_ id: String = "p-1") -> MpgdPurchaseSheet {
        MpgdPurchaseSheet(presentationId: id) { [unowned self] id, fact in
            facts.append("\(id):\(fact.rawValue)")
        }
    }

    func testOpensOnceAndClosesOnceWhenThePurchaseCallEnds() {
        let purchase = sheet()
        XCTAssertEqual(purchase.answer, "requested")
        purchase.open()
        purchase.open()
        XCTAssertEqual(purchase.answer, "open")
        purchase.end()
        purchase.end()
        purchase.open()
        XCTAssertEqual(facts, ["p-1:open", "p-1:closed"])
        XCTAssertEqual(purchase.answer, "closed")
        XCTAssertEqual(purchase.ended, .closed)
    }

    func testReportsNotStartedForARefusalBeforeTheSheet() {
        let refused = sheet("p-2")
        refused.end()
        refused.open()
        refused.end()
        XCTAssertEqual(facts, ["p-2:not-started"])
        XCTAssertEqual(refused.answer, "not-started")
    }

    func testAcceptsOnlyBoundedPresentationIds() {
        XCTAssertTrue(MpgdPurchaseSheet.isValidPresentationId("0f8fad5b-d9cb-469f-a165-70867728950e"))
        XCTAssertFalse(MpgdPurchaseSheet.isValidPresentationId(nil))
        XCTAssertFalse(MpgdPurchaseSheet.isValidPresentationId(""))
        XCTAssertFalse(MpgdPurchaseSheet.isValidPresentationId(String(repeating: "a", count: 65)))
        XCTAssertFalse(MpgdPurchaseSheet.isValidPresentationId("id with space"))
        XCTAssertFalse(MpgdPurchaseSheet.isValidPresentationId("ü"))
        XCTAssertEqual(MpgdPurchaseSheet.protocolVersion, 1)
    }
}
