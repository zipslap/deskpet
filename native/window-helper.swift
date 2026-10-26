// Window helper for the desktop pet: which app is in front and which windows are on screen. No special permission:
// geometry and owner names are available to any process; window *titles* and pixels would need Screen Recording,
// and this helper never reads either.
//
//   window-helper windows
//       One JSON line: {"frontmost":{"name","bundleId","pid"}|null,
//                       "windows":[{"id","owner","bundleId","pid","x","y","w","h"}...],   (layer 0, on screen, front to back)
//                       "displays":[{"x","y","w","h","main"}...]}
//   window-helper preflight
//       {"screenCapture": true|false}  -- whether Screen Recording is already granted. Never prompts.
import AppKit
import CoreGraphics
import Foundation

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func bundleId(_ pid: pid_t) -> String {
    NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
}

switch CommandLine.arguments.dropFirst().first ?? "windows" {
case "preflight":
    emit(["screenCapture": CGPreflightScreenCaptureAccess()])
default:
    var front: Any = NSNull()
    if let app = NSWorkspace.shared.frontmostApplication {
        front = ["name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier)]
    }
    var windows: [[String: Any]] = []
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
        for w in list {
            guard (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
            let alpha = (w[kCGWindowAlpha as String] as? Double) ?? 1
            guard alpha > 0.05 else { continue }
            let b = (w[kCGWindowBounds as String] as? [String: Any]) ?? [:]
            let wd = (b["Width"] as? Double) ?? 0, ht = (b["Height"] as? Double) ?? 0
            guard wd >= 40, ht >= 40 else { continue }
            let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? 0
            windows.append([
                "id": (w[kCGWindowNumber as String] as? Int) ?? 0,
                "owner": (w[kCGWindowOwnerName as String] as? String) ?? "",
                "bundleId": bundleId(pid_t(pid)),
                "pid": pid,
                "x": (b["X"] as? Double) ?? 0, "y": (b["Y"] as? Double) ?? 0, "w": wd, "h": ht
            ])
        }
    }
    var displays: [[String: Any]] = []
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    if CGGetActiveDisplayList(16, &ids, &count) == .success {
        for id in ids.prefix(Int(count)) {
            let r = CGDisplayBounds(id)
            displays.append(["x": r.origin.x, "y": r.origin.y, "w": r.size.width, "h": r.size.height, "main": CGDisplayIsMain(id) != 0])
        }
    }
    emit(["frontmost": front, "windows": windows, "displays": displays])
}
