#!/usr/bin/env node
// Stand-in for native/window-helper used by tests: prints whatever JSON is in $PET_FAKE_WINDOWS_FILE for `windows`
// (or a quiet one-window desktop if unset), and {"screenCapture":true} for `preflight`.
import { appendFileSync, readFileSync } from 'node:fs'
const cmd = process.argv[2] ?? 'windows'
// every call is logged beside the data file, so a test can tell whether (and how often) the app asked
if (process.env.PET_FAKE_WINDOWS_FILE) try { appendFileSync(process.env.PET_FAKE_WINDOWS_FILE + '.log', cmd + '\n') } catch {}
if (cmd === 'preflight') {
  console.log(JSON.stringify({ screenCapture: true }))
} else {
  let snap = { frontmost: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 4242 }, windows: [{ id: 1, owner: 'Notes', bundleId: 'com.apple.Notes', pid: 4242, x: 100, y: 100, w: 800, h: 600 }], displays: [{ x: 0, y: 0, w: 1710, h: 1112, main: true }] }
  try { if (process.env.PET_FAKE_WINDOWS_FILE) snap = JSON.parse(readFileSync(process.env.PET_FAKE_WINDOWS_FILE, 'utf8')) } catch {}
  console.log(JSON.stringify(snap))
}
