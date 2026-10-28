import Foundation

/// The purchase sheet facts of one `purchase` call that sent a presentation
/// id. The plugin reports `open` right before OpenIAP calls
/// `Product.purchase()` and `closed` when that returns or throws; a call it
/// refuses before then is `not-started`. Each sheet reports at most one
/// `open` and exactly one terminal fact, whatever order the plugin calls
/// these in. Apple documents that `Product.purchase()` presents the
/// confirmation sheet, not that it returns only once the sheet is dismissed,
/// so `closed` is "the purchase call ended" until device testing proves more.
public final class MpgdPurchaseSheet {
    public enum Fact: String, Sendable {
        case open
        case closed
        case notStarted = "not-started"
    }

    /// The facts protocol version `getPresentationSupport` declares.
    public static let protocolVersion = 1

    public let presentationId: String
    private let emit: (String, Fact) -> Void
    private var opened = false
    public private(set) var ended: Fact?

    public init(presentationId: String, emit: @escaping (String, Fact) -> Void) {
        self.presentationId = presentationId
        self.emit = emit
    }

    /// The `presentation` value of the call's answer: the terminal fact, or
    /// `open` while the sheet is up, or `requested` before anything happened.
    public var answer: String {
        if let ended { return ended.rawValue }
        return opened ? Fact.open.rawValue : "requested"
    }

    public func open() {
        guard ended == nil, !opened else { return }
        opened = true
        emit(presentationId, .open)
    }

    /// The purchase call ended: `closed` after `open`, otherwise `not-started`.
    public func end() {
        guard ended == nil else { return }
        let fact: Fact = opened ? .closed : .notStarted
        ended = fact
        emit(presentationId, fact)
    }

    /// 1-64 characters of `[A-Za-z0-9-]`, as the TypeScript SDK sends (a UUID).
    public static func isValidPresentationId(_ value: String?) -> Bool {
        guard let value, !value.isEmpty, value.count <= 64 else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            (scalar.value >= 0x30 && scalar.value <= 0x39)
                || (scalar.value >= 0x41 && scalar.value <= 0x5A)
                || (scalar.value >= 0x61 && scalar.value <= 0x7A)
                || scalar == "-"
        }
    }
}
