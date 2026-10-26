#!/bin/bash
# Builds the Swift helpers: native/speech-helper (microphone + speech recognition) and native/window-helper (frontmost app and
# window geometry, no permissions). Each is skipped if up to date. Never fails the caller: without a helper the app still
# runs and the chat panel explains that the matching feature is unavailable.
cd "$(dirname "$0")/.." || exit 0
if ! command -v swiftc >/dev/null 2>&1; then
  echo "build-helper: swiftc not found (install Xcode Command Line Tools: xcode-select --install). Voice input and screen features will be unavailable." >&2
  exit 0
fi

OUT=native/speech-helper
if [ ! -x "$OUT" ] || [ native/speech-helper.swift -nt "$OUT" ] || [ native/Info.plist -nt "$OUT" ]; then
  echo "build-helper: compiling $OUT"
  swiftc -O -swift-version 5 native/speech-helper.swift -o "$OUT" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/Info.plist \
    && codesign -s - --force --identifier com.deskpet.speech-helper "$OUT" \
    || { echo "build-helper: build failed; voice input will be unavailable." >&2; rm -f "$OUT"; }
fi

# The window helper needs no permissions, so no Info.plist or entitlements.
WOUT=native/window-helper
if [ ! -x "$WOUT" ] || [ native/window-helper.swift -nt "$WOUT" ]; then
  echo "build-helper: compiling $WOUT"
  swiftc -O -swift-version 5 native/window-helper.swift -o "$WOUT" \
    && codesign -s - --force --identifier com.deskpet.window-helper "$WOUT" \
    || { echo "build-helper: window helper build failed; screen features will be unavailable." >&2; rm -f "$WOUT"; }
fi

# Node-API addon that puts the cat's window on the desktop layer (below all apps). Plain C API, so it works in any Electron.
LOUT=native/window-level.node
NODE_INC=""
for d in /opt/homebrew/include/node /usr/local/include/node "$(dirname "$(dirname "$(command -v node 2>/dev/null || echo /x/x)")")/include/node"; do
  [ -f "$d/node_api.h" ] && { NODE_INC="$d"; break; }
done
if [ ! -f "$LOUT" ] || [ native/window-level.m -nt "$LOUT" ]; then
  if [ -z "$NODE_INC" ]; then
    echo "build-helper: node_api.h not found; the cat will use an ordinary window level instead of the desktop layer." >&2
  else
    echo "build-helper: compiling $LOUT"
    clang -O2 -fobjc-arc -bundle -undefined dynamic_lookup -DNODE_GYP_MODULE_NAME=window_level -I"$NODE_INC" \
      -framework AppKit native/window-level.m -o "$LOUT" \
      && codesign -s - --force "$LOUT" \
      || { echo "build-helper: window-level build failed; the cat will use an ordinary window level." >&2; rm -f "$LOUT"; }
  fi
fi
exit 0
