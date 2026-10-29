import SwiftUI
import PushArmorCore

/// Brand colours from App/Assets.xcassets (light, dark and high contrast live in the catalog).
extension Color {
    static let brandGreen = Color("BrandGreen")
    static let onBrandGreen = Color("OnBrandGreen")
    static let ctaEdge = Color("CTAEdge")
    static let secondaryText = Color("SecondaryText")
    static let success = Color("Success")
    static let armorText = Color("ArmorText")
    static let iconTileBg = Color("IconTileBg")
    static let iconTileFg = Color("IconTileFg")
    static let hero = Color("Hero")
    static let heroBorder = Color("HeroBorder")
    static let onHero = Color("OnHero")
    static let onHero2 = Color("OnHero2")
    static let heroIconBg = Color("HeroIconBg")
    static let plate = Color("Plate")
    static let fpCell = Color("FpCell")
    static let illoHalo = Color("IlloHalo")
    static let illoRing = Color("IlloRing")
    static let tileEdge = Color("TileEdge")
    /// The app icon tile; the same in light and dark.
    static let brandNavy = Color(red: 0x1F / 255, green: 0x3A / 255, blue: 0x5F / 255)
}

/// SF Symbol for a peer platform.
func platformSymbol(_ platform: String?) -> String {
    switch platform {
    case "iphone": return "iphone"
    case "android": return "smartphone"
    case "chrome": return "laptopcomputer"
    case "firefox": return "desktopcomputer"
    default: return "questionmark.circle"
    }
}

/// The shield with the arrow cut out (brand/pusharmor-icon-large.svg geometry), fitted to the
/// rect. Fill it with an even-odd FillStyle so the arrow stays open.
struct ShieldShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w: CGFloat = 240, h: CGFloat = 298   // shield bounds in icon units: x 136-376, y 108-406
        let s = min(rect.width / w, rect.height / h)
        let ox = rect.midX - (136 + w / 2) * s
        let oy = rect.midY - (108 + h / 2) * s
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
        var path = Path()
        path.move(to: p(256, 108))
        path.addLine(to: p(376, 150))
        path.addLine(to: p(376, 250))
        path.addCurve(to: p(256, 406), control1: p(376, 330), control2: p(322, 382))
        path.addCurve(to: p(136, 250), control1: p(190, 382), control2: p(136, 330))
        path.addLine(to: p(136, 150))
        path.closeSubpath()
        path.move(to: p(256, 168))
        path.addLine(to: p(318, 236))
        path.addLine(to: p(280, 236))
        path.addLine(to: p(280, 334))
        path.addLine(to: p(232, 334))
        path.addLine(to: p(232, 236))
        path.addLine(to: p(194, 236))
        path.closeSubpath()
        return path
    }
}

/// The app icon tile, drawn as vectors.
struct BrandTileView: View {
    let size: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: size * 112 / 512, style: .continuous)
            .fill(Color.brandNavy)
            .overlay(
                ShieldShape()
                    .fill(Color.brandGreen, style: FillStyle(eoFill: true))
                    .frame(width: size * 240 * 1.22 / 512, height: size * 298 * 1.22 / 512)
            )
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// "Push" in brand green, "Armor" in the armor ink.
struct Wordmark: View {
    @ScaledMetric private var size: CGFloat

    init(size: CGFloat) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: size >= 30 ? .largeTitle : .title2)
    }

    var body: some View {
        (Text("Push").foregroundColor(.brandGreen) + Text("Armor").foregroundColor(.armorText))
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

/// Peer state shape: filled dot, ring, or ring with a bar.
enum StatusKind { case approves, notApproved, off }

struct StatusMark: View {
    let kind: StatusKind

    var body: some View {
        switch kind {
        case .approves:
            Circle().fill(Color.success).frame(width: 10, height: 10)
        case .notApproved:
            Circle().stroke(Color.secondaryText, lineWidth: 1.6).frame(width: 9, height: 9).frame(width: 10, height: 10)
        case .off:
            ZStack {
                Circle().stroke(Color.secondaryText, lineWidth: 1.6).frame(width: 9, height: 9)
                Capsule().fill(Color.secondaryText).frame(width: 6, height: 1.6)
            }
            .frame(width: 10, height: 10)
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

/// The This device cell content. The navy background is HeroBackground (a row background).
struct HeroCell: View {
    let name: String
    var plain = false
    let rename: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            if plain {
                IconTile("iphone", size: 44)
            } else {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.heroIconBg)
                    .frame(width: 44, height: 44)
                    .overlay(Image(systemName: "iphone").font(.title3).foregroundStyle(.white))
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(.headline)
                    .foregroundStyle(plain ? Color.primary : Color.onHero)
                Text("This device")
                    .font(.subheadline)
                    .foregroundStyle(plain ? Color.secondaryText : Color.onHero2)
            }
            Spacer(minLength: 8)
            Button("Rename", action: rename)
                .buttonStyle(.borderless)
                .font(.body.weight(.semibold))
                .foregroundStyle(plain ? Color.accentColor : Color.onHero)
                .frame(minHeight: 44)
        }
        .frame(minHeight: 76 - 28)
    }
}

/// Navy row background with a faint shield watermark (none with Reduce Transparency).
struct HeroBackground: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var radius: CGFloat {
        if #available(iOS 26, *) { return 26 }
        return 10
    }

    var body: some View {
        Color.hero
            .overlay(alignment: .trailing) {
                if !reduceTransparency {
                    ShieldShape()
                        .fill(Color.white.opacity(0.04), style: FillStyle(eoFill: true))
                        .frame(width: 112 * 240 / 298, height: 112)
                        .rotationEffect(.degrees(-12))
                        .padding(.trailing, 96)
                        .offset(y: 12)
                        .accessibilityHidden(true)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.heroBorder, lineWidth: 1))
            .clipped()
    }
}

/// The pairing fingerprint on a tinted plate: caps label, one cell per character, check line.
struct FingerprintPlate: View {
    let code: String
    let peer: String
    @ScaledMetric private var cell: CGFloat = 40
    @Environment(\.dynamicTypeSize) private var typeSize

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
    }

    private var chars: [String] { code.map(String.init) }

    @ViewBuilder
    private var cells: some View {
        if typeSize >= .accessibility1 {
            grid
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    ForEach(chars.indices, id: \.self) { i in cellView(chars[i]) }
                }
                grid
            }
        }
    }

    private var grid: some View {
        Grid(horizontalSpacing: 10, verticalSpacing: 10) {
            ForEach(Array(stride(from: 0, to: chars.count, by: 2)), id: \.self) { i in
                GridRow {
                    cellView(chars[i])
                    if i + 1 < chars.count { cellView(chars[i + 1]) }
                }
            }
        }
    }

    private func cellView(_ ch: String) -> some View {
        Text(ch)
            .font(.system(size: cell, weight: .semibold, design: .monospaced))
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
