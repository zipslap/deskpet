// Tiny Node-API addon for the pet window: puts it on the desktop layer, just above the desktop icons and below every app
// window, on the Space it is on. Electron's own levels only go from "normal" upwards, so this is the one thing it cannot do.
//   setDesktopLevel(handle: Buffer) -> boolean     handle = BrowserWindow.getNativeWindowHandle() (an NSView*)
// Built by tools/build-helper.sh; the app falls back to an ordinary window level if it is missing.
#import <AppKit/AppKit.h>
#include <node_api.h>

static napi_value SetDesktopLevel(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value result;
  bool ok = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc == 1) {
    void *data = NULL;
    size_t len = 0;
    if (napi_get_buffer_info(env, argv[0], &data, &len) == napi_ok && len >= sizeof(void *)) {
      NSView *view = (__bridge NSView *)(*(void **)data);
      NSWindow *win = [view isKindOfClass:[NSView class]] ? [view window] : nil;
      if (win) {
        [win setLevel:CGWindowLevelForKey(kCGDesktopIconWindowLevelKey) + 1];
        NSWindowCollectionBehavior b = [win collectionBehavior];
        b &= ~(NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorMoveToActiveSpace |
               NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorManaged);
        // Stationary: Mission Control and "show desktop" leave it where it is, like the desktop itself.
        b |= NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
        [win setCollectionBehavior:b];
        ok = true;
      }
    }
  }
  napi_get_boolean(env, ok, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "setDesktopLevel", NAPI_AUTO_LENGTH, SetDesktopLevel, NULL, &fn);
  napi_set_named_property(env, exports, "setDesktopLevel", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
