import AppKit
import WebKit

let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/cloud-pet")
let claude = "com.anthropic.claudefordesktop"
let size = NSSize(width: 64, height: 72)
let wide: CGFloat = 310

struct Session: Decodable {
  let sessionId, project, mood, line, detail: String
  let changedAt, heartbeatAt: Double
}

func read(_ name: String) -> [String: Any]? {
  try? JSONSerialization.jsonObject(with: Data(contentsOf: home.appendingPathComponent(name))) as? [String: Any]
}

func screen(at point: NSPoint) -> NSRect {
  (NSScreen.screens.first { $0.frame.contains(point) } ?? NSScreen.main)?.visibleFrame ?? .zero
}

final class Panel: NSPanel {
  override var canBecomeKey: Bool { false }
}

final class Mouse: NSView {
  weak var cloud: Cloud?
  var down = NSPoint.zero
  var origin: NSPoint?

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }

  override func mouseEntered(with event: NSEvent) { cloud?.hover(true) }
  override func mouseExited(with event: NSEvent) { cloud?.hover(false) }
  override func rightMouseDown(with event: NSEvent) { cloud?.menu(event, in: self) }
  override func mouseUp(with event: NSEvent) { origin == nil ? cloud?.clicked() : cloud?.endDrag() }

  override func mouseDown(with event: NSEvent) {
    down = NSEvent.mouseLocation
    origin = nil
  }

  override func mouseDragged(with event: NSEvent) {
    let point = NSEvent.mouseLocation
    guard let cloud, origin != nil || hypot(point.x - down.x, point.y - down.y) > 3 else { return }
    let start = origin ?? cloud.beginDrag()
    origin = start
    cloud.drag(to: NSPoint(x: start.x + point.x - down.x, y: start.y + point.y - down.y))
  }
}

final class Cloud: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  var panel: Panel!
  let web = WKWebView()
  var state: [String: Any] = [:]
  var prefs: [String: Any] = [:]
  var shown = ""
  var seenAt = 0.0
  var idleSince: Date?
  var pageDate: Date?
  var isHovering = false
  var isDragging = false

  var anchor: NSPoint {
    get {
      let saved = NSPoint(x: UserDefaults.standard.double(forKey: "x"), y: UserDefaults.standard.double(forKey: "y"))
      if UserDefaults.standard.object(forKey: "x") != nil, NSScreen.screens.contains(where: { $0.visibleFrame.contains(NSRect(origin: saved, size: size)) }) { return saved }
      let screen = NSScreen.main?.visibleFrame ?? .zero
      return NSPoint(x: screen.maxX - size.width - 24, y: screen.minY + 24)
    }
    set {
      UserDefaults.standard.set(newValue.x, forKey: "x")
      UserDefaults.standard.set(newValue.y, forKey: "y")
    }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    panel = Panel(contentRect: NSRect(origin: anchor, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.ignoresMouseEvents = false
    web.setValue(false, forKey: "drawsBackground")
    web.underPageBackgroundColor = .clear
    web.navigationDelegate = self
    let mouse = Mouse()
    mouse.cloud = self
    let content = NSView(frame: NSRect(origin: .zero, size: size))
    for view in [web, mouse] {
      view.frame = content.bounds
      view.autoresizingMask = [.width, .height]
      content.addSubview(view)
    }
    panel.contentView = content
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
      if (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier == claude { self.seenAt = Date().timeIntervalSince1970 * 1000 }
    }
    Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in self.tick() }
    tick()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    shown = ""
    layout()
  }

  func tick() {
    let page = home.appendingPathComponent("pet.html")
    if let date = (try? FileManager.default.attributesOfItem(atPath: page.path))?[.modificationDate] as? Date, date != pageDate {
      pageDate = date
      web.loadFileURL(page, allowingReadAccessTo: home)
    }
    prefs = read("prefs.json") ?? prefs
    let now = Date().timeIntervalSince1970 * 1000
    let files = (try? FileManager.default.contentsOfDirectory(at: home.appendingPathComponent("sessions"), includingPropertiesForKeys: nil)) ?? []
    let live = files.compactMap { try? JSONDecoder().decode(Session.self, from: Data(contentsOf: $0)) }.filter { $0.mood != "ended" && now - $0.heartbeatAt < 180_000 }
    func rank(_ s: Session) -> Int {
      switch s.mood {
      case "waiting": return 3
      case "working": return 2
      case "done", "stopped": return s.changedAt > seenAt ? 1 : 0
      default: return 0
      }
    }
    let top = live.filter { rank($0) > 0 }.max { (rank($0), $0.changedAt) < (rank($1), $1.changedAt) }
    let busy = live.filter { rank($0) > 1 }.count
    let quiet = live.isEmpty ? "No session is reporting to Cloud" : "\(live.count) session\(live.count == 1 ? "" : "s") open, all quiet"
    let mood = top?.mood ?? "sleeping"
    let title = "\(prefs["name"] as? String ?? "Cloud") · \(top?.line ?? "Napping")"
    state = ["mood": mood, "title": title, "sub": top.map { "\($0.project): \($0.detail)" + (busy > 1 ? " · \(busy - 1) more busy" : "") } ?? quiet]
    let isOpen = !NSRunningApplication.runningApplications(withBundleIdentifier: claude).isEmpty
    idleSince = isOpen || !live.isEmpty ? nil : idleSince ?? Date()
    if let idleSince, Date().timeIntervalSince(idleSince) > 60 { NSApp.terminate(nil) }
    let shows = prefs["isHidden"] as? Bool != true && idleSince == nil
    if shows != panel.isVisible { shows ? panel.orderFrontRegardless() : panel.orderOut(nil) }
    layout()
  }

  func layout() {
    let open = !isDragging && isHovering
    let side = anchor.x + size.width - wide < screen(at: anchor).minX ? "right" : "left"
    var frame = NSRect(origin: anchor, size: size)
    if open {
      frame.size.width = wide
      if side == "left" { frame.origin.x -= wide - size.width }
    }
    if !isDragging, frame != panel.frame { panel.setFrame(frame, display: true) }
    state["bubble"] = open
    state["side"] = side
    if let data = try? JSONSerialization.data(withJSONObject: state, options: .sortedKeys), let json = String(data: data, encoding: .utf8), json != shown {
      shown = json
      web.evaluateJavaScript("show(\(json))")
    }
  }

  func hover(_ isOver: Bool) {
    isHovering = isOver
    layout()
  }

  func beginDrag() -> NSPoint {
    isDragging = true
    panel.setFrame(NSRect(origin: anchor, size: size), display: true)
    layout()
    return anchor
  }

  func drag(to point: NSPoint) {
    let bounds = screen(at: NSEvent.mouseLocation)
    panel.setFrameOrigin(NSPoint(x: min(max(point.x, bounds.minX), bounds.maxX - size.width), y: min(max(point.y, bounds.minY), bounds.maxY - size.height)))
  }

  func endDrag() {
    anchor = panel.frame.origin
    isDragging = false
    layout()
  }

  func clicked() {
    seenAt = Date().timeIntervalSince1970 * 1000
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: claude) { NSWorkspace.shared.openApplication(at: url, configuration: .init()) }
    tick()
  }

  func menu(_ event: NSEvent, in view: NSView) {
    let menu = NSMenu()
    let muted = prefs["isMuted"] as? Bool == true
    for (title, action) in [("Open Claude", #selector(openClaude)), (muted ? "Unmute notifications" : "Mute notifications", #selector(mute)), ("Hide (/pet brings it back)", #selector(hide))] {
      menu.addItem(withTitle: title, action: action, keyEquivalent: "").target = self
    }
    NSMenu.popUpContextMenu(menu, with: event, for: view)
  }

  @objc func openClaude() { clicked() }
  @objc func mute() { save("isMuted", prefs["isMuted"] as? Bool != true) }
  @objc func hide() { save("isHidden", true) }

  func save(_ key: String, _ value: Bool) {
    var prefs = read("prefs.json") ?? self.prefs
    prefs[key] = value
    try? JSONSerialization.data(withJSONObject: prefs).write(to: home.appendingPathComponent("prefs.json"), options: .atomic)
    tick()
  }
}

let cloud = Cloud()
NSApplication.shared.delegate = cloud
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
