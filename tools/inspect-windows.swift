// Lists on-screen windows owned by Electron (bounds, layer, alpha). Needs no special permission:
// window titles and pixels would need Screen Recording, geometry does not.
// Usage: swift tools/inspect-windows.swift [ownerSubstring]
import Foundation
import CoreGraphics

let filter = CommandLine.arguments.dropFirst().first?.lowercased() ?? "electron"
let opts: CGWindowListOption = [.optionOnScreenOnly]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
for w in list {
  let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
  guard owner.lowercased().contains(filter) else { continue }
  let b = (w[kCGWindowBounds as String] as? [String: Any]) ?? [:]
  let layer = w[kCGWindowLayer as String] ?? "?"
  let alpha = w[kCGWindowAlpha as String] ?? "?"
  let num = w[kCGWindowNumber as String] ?? "?"
  print("{\"owner\":\"\(owner)\",\"id\":\(num),\"layer\":\(layer),\"alpha\":\(alpha),\"x\":\(b["X"] ?? 0),\"y\":\(b["Y"] ?? 0),\"w\":\(b["Width"] ?? 0),\"h\":\(b["Height"] ?? 0)}")
}
