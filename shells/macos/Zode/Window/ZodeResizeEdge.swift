import AppKit

// =============================================================================
// MARK: - The invisible resize edges (contract §5)
// =============================================================================
//
// The window has no native chrome, so the resize affordances are invisible
// bands of 8 px along the edges. The enum describes which edge a point falls
// on; the web view uses it for hit testing and for driving the window frame.

enum ZodeResizeEdge: String, CaseIterable {
    case topLeft
    case top
    case topRight
    case left
    case right
    case bottomLeft
    case bottom
    case bottomRight

    /// The **top** edge is never a resize handle: it belongs to the web
    /// app's drag strip (contract §5.3) and must not resize the window.
    var isResizable: Bool { self != .top }

    /// Which edge (if any) the point belongs to.
    ///
    /// - Parameters:
    ///   - point: the point in the view's own coordinate system.
    ///   - rect: the bounds the edges are measured against.
    ///   - thickness: the width of the invisible edge.
    ///   - includesTop: whether the top edge may be returned.
    static func edge(at point: NSPoint, in rect: NSRect, thickness: CGFloat, includesTop: Bool) -> ZodeResizeEdge? {
        guard rect.contains(point) else { return nil }
        let nearLeft = point.x - rect.minX < thickness
        let nearRight = rect.maxX - point.x < thickness
        let nearBottom = point.y - rect.minY < thickness
        let nearTop = rect.maxY - point.y < thickness

        if nearBottom && nearLeft { return .bottomLeft }
        if nearBottom && nearRight { return .bottomRight }
        if includesTop && nearTop && nearLeft { return .topLeft }
        if includesTop && nearTop && nearRight { return .topRight }
        if nearLeft { return .left }
        if nearRight { return .right }
        if nearBottom { return .bottom }
        if includesTop && nearTop { return .top }
        return nil
    }

    /// The rectangle of the view that belongs to this edge.
    func rect(in rect: NSRect, thickness: CGFloat) -> NSRect {
        switch self {
        case .left:
            return NSRect(x: rect.minX, y: rect.minY, width: thickness, height: rect.height)
        case .right:
            return NSRect(x: rect.maxX - thickness, y: rect.minY, width: thickness, height: rect.height)
        case .bottom:
            return NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: thickness)
        case .top:
            return NSRect(x: rect.minX, y: rect.maxY - thickness, width: rect.width, height: thickness)
        case .topLeft:
            return NSRect(x: rect.minX, y: rect.maxY - thickness, width: thickness, height: thickness)
        case .topRight:
            return NSRect(x: rect.maxX - thickness, y: rect.maxY - thickness, width: thickness, height: thickness)
        case .bottomLeft:
            return NSRect(x: rect.minX, y: rect.minY, width: thickness, height: thickness)
        case .bottomRight:
            return NSRect(x: rect.maxX - thickness, y: rect.minY, width: thickness, height: thickness)
        }
    }

    /// Applies a mouse delta to the window frame.
    func apply(delta: NSPoint, to frame: inout NSRect) {
        switch self {
        case .left:
            frame.origin.x += delta.x
            frame.size.width -= delta.x
        case .right:
            frame.size.width += delta.x
        case .bottom:
            frame.size.height += delta.y
        case .top:
            frame.origin.y += delta.y
            frame.size.height -= delta.y
        case .topLeft:
            frame.origin.x += delta.x
            frame.size.width -= delta.x
            frame.origin.y += delta.y
            frame.size.height -= delta.y
        case .topRight:
            frame.size.width += delta.x
            frame.origin.y += delta.y
            frame.size.height -= delta.y
        case .bottomLeft:
            frame.origin.x += delta.x
            frame.size.width -= delta.x
            frame.size.height += delta.y
        case .bottomRight:
            frame.size.width += delta.x
            frame.size.height += delta.y
        }
    }

    /// The resize cursor for this edge.
    var cursor: NSCursor {
        switch self {
        case .left, .right:
            return NSCursor.resizeLeftRight
        case .top, .bottom:
            return NSCursor.resizeUpDown
        case .topLeft, .bottomRight:
            return ZodeResizeEdge.diagonalCursor(pointingUp: false)
        case .topRight, .bottomLeft:
            return ZodeResizeEdge.diagonalCursor(pointingUp: true)
        }
    }

    // MARK: Diagonal cursors

    private static var cursorCache: [Bool: NSCursor] = [:]

    /// AppKit only ships horizontal and vertical resize cursors, so the
    /// diagonal ones are drawn here.
    static func diagonalCursor(pointingUp: Bool) -> NSCursor {
        if let cached = cursorCache[pointingUp] { return cached }
        let size = NSSize(width: 16, height: 16)
        let image = NSImage(size: size, flipped: false) { _ in
            let path = NSBezierPath()
            path.lineWidth = 1.0
            path.lineCapStyle = .butt

            let start: NSPoint
            let end: NSPoint
            if pointingUp {
                start = NSPoint(x: 3.5, y: 3.5)
                end = NSPoint(x: 12.5, y: 12.5)
            } else {
                start = NSPoint(x: 3.5, y: 12.5)
                end = NSPoint(x: 12.5, y: 3.5)
            }
            path.move(to: start)
            path.line(to: end)
            NSColor.black.setStroke()
            path.stroke()

            // Arrow heads.
            for (tip, direction) in [(start, -1.0), (end, 1.0)] {
                let head = NSBezierPath()
                head.move(to: tip)
                if pointingUp {
                    head.line(to: NSPoint(x: tip.x + 4.0 * direction, y: tip.y + 1.0))
                    head.line(to: NSPoint(x: tip.x + 1.0, y: tip.y + 4.0 * direction))
                } else {
                    head.line(to: NSPoint(x: tip.x + 4.0 * direction, y: tip.y - 1.0))
                    head.line(to: NSPoint(x: tip.x + 1.0, y: tip.y - 4.0 * direction))
                }
                head.close()
                NSColor.black.setFill()
                head.fill()
                NSColor.white.setStroke()
                head.lineWidth = 0.5
                head.stroke()
            }
            return true
        }
        let cursor = NSCursor(image: image, hotSpot: NSPoint(x: 8, y: 8))
        cursorCache[pointingUp] = cursor
        return cursor
    }
}
