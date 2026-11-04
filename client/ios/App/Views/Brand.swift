import SwiftUI
import PushArmorCore

/// Runs a state change with no animation: tab switches, sheets, and full screen views
/// appear and go away at once.
func instantly(_ change: () -> Void) {
    var t = Transaction()
    t.disablesAnimations = true
    withTransaction(t, change)
}

/// Two buttons side by side with the primary on the right; when they do not fit (large
/// text), stacked with the primary on top.
struct ButtonPair<Primary: View, Secondary: View>: View {
    @ViewBuilder let primary: () -> Primary
    @ViewBuilder let secondary: () -> Secondary

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                secondary()
                primary()
            }
            VStack(spacing: 12) {
                primary()
                secondary()
            }
        }
    }
}

/// Brand colours from App/Assets.xcassets (light, dark and high contrast live in the catalog).
extension Color {
    static let brandGreen = Color("BrandGreen")
    static let onBrandGreen = Color("OnBrandGreen")
    static let ctaEdge = Color("CTAEdge")
    static let approveFill = Color("ApproveFill")
    static let onApproveFill = Color("OnApproveFill")
    static let secondaryText = Color("SecondaryText")
    static let success = Color("Success")
    static let errorText = Color("ErrorText")
    static let warningText = Color("WarningText")
    static let armorText = Color("ArmorText")
    /// "Push" in the wordmark: #0E7A4E on light, #15A86B on dark.
    static let pushText = Color("PushText")
    static let iconTileBg = Color("IconTileBg")
    static let iconTileFg = Color("IconTileFg")
    static let plate = Color("Plate")
    static let fpCell = Color("FpCell")
    static let illoHalo = Color("IlloHalo")
    static let illoRing = Color("IlloRing")
    static let tileEdge = Color("TileEdge")
    /// 1 pt edge on custom cards: visible on the light page and on true black.
    static let cardEdge = Color("CardEdge")
    /// The app icon tile and the mark edge; the same in light and dark.
    static let brandInk = Color(red: 0x06 / 255, green: 0x35 / 255, blue: 0x1F / 255)
    /// The mark shield; the same in light and dark.
    static let pushGreen = Color(red: 0x15 / 255, green: 0xA8 / 255, blue: 0x6B / 255)
}

/// SF Symbol for a peer platform.
func platformSymbol(_ platform: String?) -> String {
    switch platform {
    case "ios": return "iphone"
    case "android": return "smartphone"
    case "chrome": return "laptopcomputer"
    case "firefox": return "desktopcomputer"
    case "cli": return "terminal"
    default: return "questionmark.circle"
    }
}

/// The shield with the arrow cut out (brand/pusharmor-mark.svg geometry), fitted to the
/// rect. Fill it with an even-odd FillStyle so the arrow stays open. `part` draws only the
/// shield outline or only the arrow, in the same frame.
struct ShieldShape: Shape {
    enum Part { case cutout, outline, arrow }
    var part: Part = .cutout

    func path(in rect: CGRect) -> Path {
        let w: CGFloat = 240, h: CGFloat = 298   // shield bounds in icon units: x 136-376, y 108-406
        let s = min(rect.width / w, rect.height / h)
        let ox = rect.midX - (136 + w / 2) * s
        let oy = rect.midY - (108 + h / 2) * s
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
        var path = Path()
        if part != .arrow {
            path.move(to: p(256, 108))
            path.addLine(to: p(376, 150))
            path.addLine(to: p(376, 250))
            path.addCurve(to: p(256, 406), control1: p(376, 330), control2: p(322, 382))
            path.addCurve(to: p(136, 250), control1: p(190, 382), control2: p(136, 330))
            path.addLine(to: p(136, 150))
            path.closeSubpath()
        }
        if part != .outline {
            path.move(to: p(256, 164))
            path.addLine(to: p(336, 248))
            path.addLine(to: p(288, 248))
            path.addLine(to: p(288, 346))
            path.addLine(to: p(224, 346))
            path.addLine(to: p(224, 248))
            path.addLine(to: p(176, 248))
            path.closeSubpath()
        }
        return path
    }
}

/// The app icon tile, drawn as vectors.
struct BrandTileView: View {
    let size: CGFloat

    var body: some View {
        let k = size * 1.18 / 512   // points per icon unit
        RoundedRectangle(cornerRadius: size * 112 / 512, style: .continuous)
            .fill(Color.brandInk)
            .overlay(
                ZStack {
                    ShieldShape(part: .outline).fill(Color.pushGreen)
                    ShieldShape(part: .outline).stroke(Color.brandInk, style: StrokeStyle(lineWidth: 10 * k, lineJoin: .round))
                    ShieldShape(part: .arrow).fill(Color.white)
                    ShieldShape(part: .arrow).stroke(Color.brandInk, lineWidth: 12 * k)
                }
                .frame(width: 240 * k, height: 298 * k)
            )
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// "Push" in the wordmark green (pushText), "Armor" in the armor ink.
struct Wordmark: View {
    @ScaledMetric private var size: CGFloat

    init(size: CGFloat) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: size >= 30 ? .largeTitle : .title2)
    }

    var body: some View {
        (Text("Push").foregroundColor(.pushText) + Text("Armor").foregroundColor(.armorText))
            .font(.system(size: size, weight: .bold))
            .tracking(-0.4)
            .accessibilityLabel("PushArmor")
    }
}

/// The green call to action. The 1 pt inside edge gives the light fill a 3:1 boundary; it is
/// clear in dark.
struct GreenButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(Color.onBrandGreen)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(
                Capsule().fill(Color.brandGreen)
                    .overlay(Capsule().strokeBorder(Color.ctaEdge, lineWidth: 1))
            )
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.85 : (isEnabled ? 1 : 0.45))
    }
}

/// Light green tonal button (no icon): the pairing Codes match. Contrast is above 7:1 in light and dark.
struct TonalGreenButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(Color.onApproveFill)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Capsule().fill(Color.approveFill))
            .overlay(Capsule().strokeBorder(Color.brandGreen, lineWidth: 1.5))
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.85 : (isEnabled ? 1 : 0.45))
    }
}

/// Neutral button: black text on white with a thin gray border; dark surface and light text in dark mode.
struct NeutralButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    private static let surface = UIColor { $0.userInterfaceStyle == .dark ? .secondarySystemBackground : .white }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(Color.primary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Capsule().fill(Color(uiColor: Self.surface)))
            .overlay(Capsule().strokeBorder(Color(uiColor: .systemGray3), lineWidth: 1))
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.85 : (isEnabled ? 1 : 0.45))
    }
}

/// Outlined button with the error ink and no fill: the pairing Reject.
struct OutlinedDenyButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(Color.errorText)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 50)
            .overlay(Capsule().strokeBorder(Color.errorText, lineWidth: 1))
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.85 : (isEnabled ? 1 : 0.45))
    }
}

/// Peer state shape: filled dot, ring, or ring with a bar.
enum StatusKind { case approves, notApproved, off }

struct StatusMark: View {
    let kind: StatusKind
    /// 10 pt at the default text size; grows with the text.
    @ScaledMetric private var size: CGFloat = 10

    var body: some View {
        let ring = size * 0.9
        let line = size * 0.16
        switch kind {
        case .approves:
            Circle().fill(Color.success).frame(width: size, height: size)
        case .notApproved:
            Circle().stroke(Color.secondaryText, lineWidth: line).frame(width: ring, height: ring).frame(width: size, height: size)
        case .off:
            ZStack {
                Circle().stroke(Color.secondaryText, lineWidth: line).frame(width: ring, height: ring)
                Capsule().fill(Color.secondaryText).frame(width: size * 0.6, height: line)
            }
            .frame(width: size, height: size)
        }
    }
}

/// Status mark and its word, read as one element.
struct StatusLine: View {
    let kind: StatusKind
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            StatusMark(kind: kind)
            Text(text)
        }
        .font(.subheadline)
        .foregroundStyle(kind == .approves ? Color.success : Color.secondaryText)
        .accessibilityElement(children: .combine)
    }
}

/// A symbol on a rounded tinted square.
struct IconTile: View {
    let systemName: String
    private let base: CGFloat
    @ScaledMetric private var size: CGFloat

    init(_ systemName: String, size: CGFloat = 30) {
        self.systemName = systemName
        base = size
        _size = ScaledMetric(wrappedValue: size)
    }

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.6, weight: .regular))
            .foregroundStyle(Color.iconTileFg)
            .frame(width: size, height: size)
            .background(Color.iconTileBg, in: RoundedRectangle(cornerRadius: base >= 40 ? 10 : 8, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// The pairing fingerprint on a tinted plate: caps label, one cell per character, check line.
struct FingerprintPlate: View {
    let code: String
    let peer: String
    @ScaledMetric private var scaledCell: CGFloat = 40
    @State private var rowWidth: CGFloat = 0
    // All cells stay on one row: at large text sizes or on a narrow screen they shrink to fit.
    private var cell: CGFloat { Self.cellSize(scaled: scaledCell, width: rowWidth, count: chars.count) }

    /// The glyph size of a cell (a cell is 66/40 of it wide), so `count` cells 10 pt apart fit in `width`.
    static func cellSize(scaled: CGFloat, width: CGFloat, count: Int) -> CGFloat {
        let size = min(scaled, 64)
        guard width > 0, count > 0 else { return size }
        let fit = (width - CGFloat(count - 1) * 10) / CGFloat(count) * 40 / 66
        return max(1, min(size, fit))
    }

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 6) {
                ShieldShape()
                    .fill(.tint, style: FillStyle(eoFill: true))
                    .frame(width: 13, height: 13)
                Text("Pairing fingerprint")
                    .font(.caption.weight(.semibold))
                    .tracking(0.8)
                    .textCase(.uppercase)
                    .foregroundStyle(Color.secondaryText)
            }
            .accessibilityHidden(true)
            cells
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Pairing fingerprint " + code.map(String.init).joined(separator: ", "))
            Text(S.checkSameCode(peer))
                .font(.subheadline)
                .foregroundStyle(Color.secondaryText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 16)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity)
        .background(Color.plate, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.cardEdge, lineWidth: 1))
    }

    private var chars: [String] { code.map(String.init) }

    private var cells: some View {
        HStack(spacing: 10) {
            ForEach(chars.indices, id: \.self) { i in cellView(chars[i]) }
        }
        .frame(maxWidth: .infinity)
        .background(GeometryReader { g in
            Color.clear
                .onAppear { rowWidth = g.size.width }
                .onChange(of: g.size.width) { _, w in rowWidth = w }
        })
    }

    private func cellView(_ ch: String) -> some View {
        Text(ch)
            .font(.system(size: cell, weight: .semibold, design: .monospaced))
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .foregroundStyle(Color.primary)
            .frame(width: cell * 66 / 40, height: cell * 78 / 40)
            .background(Color.fpCell, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color(.systemGray), lineWidth: 1))
    }
}

// MARK: illustrations (decorative)

/// Peers empty state: the tile in a halo with three device satellites.
struct DevicesIllustration: View {
    var body: some View {
        ZStack {
            Circle().fill(Color.illoHalo).frame(width: 120, height: 120)
            Circle().stroke(Color.illoRing, lineWidth: 1.5).frame(width: 120, height: 120)
            Circle()
                .stroke(Color.illoRing, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [3, 7]))
                .frame(width: 176, height: 176)
            satellite("iphone").offset(x: 0, y: -88)
            satellite("laptopcomputer").offset(x: 76, y: 44)
            satellite("ipad").offset(x: -76, y: 44)
            BrandTileView(size: 56)
        }
        .frame(width: 200, height: 200)
        .accessibilityHidden(true)
    }

    private func satellite(_ name: String) -> some View {
        Circle()
            .fill(Color(.secondarySystemGroupedBackground))
            .overlay(Circle().stroke(Color.illoRing, lineWidth: 1.5))
            .frame(width: 38, height: 38)
            .overlay(Image(systemName: name).font(.system(size: 18)).foregroundStyle(Color.iconTileFg))
    }
}

/// History empty state: stacked message cards in a halo.
struct MessagesIllustration: View {
    var body: some View {
        ZStack(alignment: .topLeading) {
            Circle().fill(Color.illoHalo).frame(width: 148, height: 148).offset(x: 26, y: 14)
            card(96, 40, 10).opacity(0.55).offset(x: 52, y: 26)
            card(120, 46, 12).opacity(0.8).offset(x: 40, y: 48)
            card(148, 62, 14).offset(x: 26, y: 76)
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.iconTileBg)
                .frame(width: 32, height: 32)
                .overlay(Image(systemName: "link").font(.system(size: 18)).foregroundStyle(Color.iconTileFg))
                .offset(x: 40, y: 91)
            RoundedRectangle(cornerRadius: 4).fill(Color(.systemGray5)).frame(width: 76, height: 8).offset(x: 82, y: 96)
            RoundedRectangle(cornerRadius: 4).fill(Color(.systemGray5)).frame(width: 50, height: 8).offset(x: 82, y: 111)
        }
        .frame(width: 200, height: 170, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    private func card(_ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: r, style: .continuous)
            .fill(Color(.secondarySystemGroupedBackground))
            .overlay(RoundedRectangle(cornerRadius: r, style: .continuous).stroke(Color.illoRing, lineWidth: 1.5))
            .frame(width: w, height: h)
    }
}

/// Sign-in and welcome header: the tile on a halo disc.
struct SignInHalo: View {
    var body: some View {
        ZStack {
            Circle().fill(Color.illoHalo).frame(width: 180, height: 180)
            Circle().stroke(Color.illoRing, lineWidth: 1.5).frame(width: 180, height: 180)
            BrandTileView(size: 96)
                .overlay(RoundedRectangle(cornerRadius: 21, style: .continuous).strokeBorder(Color.tileEdge, lineWidth: 1))
        }
        .frame(width: 300, height: 198)
        .accessibilityHidden(true)
    }
}
