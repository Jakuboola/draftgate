// The HARNESS half of the host, compiled only into `draftgate-harness.app` (`-DDG_HARNESS`).
//
// Everything a verifier asks of the window that a review never needs: evaluate script, synthesise
// input, read the menus, report what the page logged. `draftgate.app` is built without this
// file, so the review window has no eval path and no code that can click: the capability is absent,
// not gated. The price is that a verifier drives a binary that differs from the shipped one: by
// this file, and by the `DG_HARNESS` branches in `draftgate.m` that call it -- the window comes
// forward through `-show` but never activates, it is placed off every screen at a lower level and
// on one desktop, it keeps its own placement file, the app is an accessory -- and by its plist
// (`LSUIElement`, its own bundle id). So what a verifier cannot vouch for is exactly that: how a
// REVIEW window takes the keyboard when its app activates, and where it is placed.
//
// ## The channel
//
// Two FIFOs in `$DRAFTGATE_HARNESS` (`in`, `out`), one JSON object per line. A FIFO rather than
// stdio because the CLI owns a window's stdio when IT spawns one, and a path because the attaching
// side must find the window it did not spawn. The verifier closing it ends the conversation at once
// and the window five seconds later: a flow's last message is often a click still queued on the
// main thread when the channel goes, and it must land.
//
// ## A harness window is never on a screen
//
// No Dock icon (`LSUIElement`, and the accessory policy in `draftgate.m`), and no pixel on any
// display: the window sits thirty thousand points off every screen. On its own that is not
// enough -- WebKit reports a window it judges occluded as `visibilityState: hidden` and stops
// `requestAnimationFrame`, and it judges a window off every display, behind a locked screen or on a
// sleeping display occluded (measured, the locked screen included). So the harness switches
// WebKit's occlusion detection off (`_setWindowOcclusionDetectionEnabled:`, SPI, the harness build
// only), and the page then draws and animates as a visible one does -- off-screen, locked or asleep.
// No sliver of the window has to stay on a screen; its 1% opacity stays, for whatever might bring
// the window on screen. A window never ordered in at all stays hidden whatever the switch says.
//
// It is ordered in by the host's own `-show`, when the page has loaded, exactly as a review's is: a
// harness that ordered its window in by another path, before there was a web view, would never meet
// the focus a review's window is given. What `-show` skips in a harness is the activation, so the
// window is never KEY -- an app that is not active has no key window -- and `becomeKey` stands in.
//
// And it outlives nobody: when whatever spawned it is gone, it exits.

#ifdef DG_HARNESS

#import "host.h"

#include <objc/message.h>
#include <signal.h>
#include <unistd.h>

// Console output and page errors, as the page itself can observe them. WKWebView has no public
// console API, so WebKit's OWN messages are unreachable; what is reachable is the page's
// `console.*` calls and `error` / `unhandledrejection`. This runs in the PAGE world, because it has
// to wrap the page's own `console`, so anything the page runs can post to `dgharness` as well.
static NSString *const CAPTURE_SCRIPT =
    @"(() => {\n"
     "  const h = window.webkit.messageHandlers.dgharness;\n"
     "  const post = h.postMessage.bind(h);\n"
     "  const send = (m) => { try { post(m); } catch (e) {} };\n"
     "  const fmt = (a) => {\n"
     "    if (typeof a === 'string') return a;\n"
     "    if (a instanceof Error) return String(a);\n"
     "    try { return JSON.stringify(a); } catch (e) { return String(a); }\n"
     "  };\n"
     "  for (const [name, level] of [['log', 'log'], ['info', 'info'], ['warn', 'warning'], ['error', 'error'], "
     "['debug', 'debug']]) {\n"
     "    const orig = console[name];\n"
     "    console[name] = function (...args) {\n"
     "      send({ source: 'console', level, text: args.map(fmt).join(' ') });\n"
     "      return orig.apply(this, args);\n"
     "    };\n"
     "  }\n"
     "  window.addEventListener('error', (e) => {\n"
     "    if (e instanceof ErrorEvent) send({ source: 'javascript', level: 'error', text: 'Uncaught ' + e.message });\n"
     "  }, true);\n"
     "  window.addEventListener('unhandledrejection', (e) =>\n"
     "    send({ source: 'javascript', level: 'error', text: 'Unhandled Promise Rejection: ' + fmt(e.reason) }));\n"
     "})();\n";

// The CSP engine's `securitypolicyviolation` events, which are the probe's positive control: the
// one CSP fact that is not an absence. So they are listened for in a content world of the harness's
// OWN and posted to a handler only that world can see. The page shares the DOM with this world and
// so receives the same events, but it cannot reach `dgsecurity`, and `isTrusted` is read here, on
// the engine's event: an event the page dispatches itself arrives with it false. Nothing the page
// runs can tamper with this world's `postMessage`, so it is called as it is. `DGHarness` sets
// every message's `trusted` from which handler it came through (`dgsecurity` exists only here).
static NSString *const SECURITY_SCRIPT =
    @"(() => {\n"
     "  const h = window.webkit.messageHandlers.dgsecurity;\n"
     "  document.addEventListener('securitypolicyviolation', (e) => h.postMessage({\n"
     "    source: 'security', level: 'error', trusted: e.isTrusted,\n"
     "    text: \"'\" + e.blockedURI + \"' violates the following Content Security Policy directive: \\\"\" +\n"
     "      e.violatedDirective + '\" (effective ' + e.effectiveDirective + ', ' + e.disposition + ')',\n"
     "  }));\n"
     "})();\n";

@interface DGHarness : NSObject <WKScriptMessageHandler>
@property(nonatomic, weak) DGHost *host;
@property(nonatomic, strong) NSFileHandle *out;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *messages;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *pendingReloads;
@property(nonatomic, copy, nullable) NSArray<NSString *> *lastMenu;
@property(nonatomic) NSInteger menusOpened;
@end

static DGHarness *harness;
static NSWindowLevel hostLevel;
static NSWindowCollectionBehavior hostCollectionBehavior;
// Set by `becomeKey`: the window answers `isKeyWindow` as a key window does, and nothing else.
static BOOL standsInForKey;

// A key window, as far as anything ASKING is concerned -- WebKit asks this window `isKeyWindow`, and
// hears `NSWindowDidBecomeKeyNotification`, to decide that its page has the focus. The window
// server is never told, so the real keyboard stays with whatever app has it.
@implementation DGWindow (Harness)

- (BOOL)isKeyWindow {
  return standsInForKey || [super isKeyWindow];
}

@end

static id DGJSONSafe(id value) { return value ?: NSNull.null; }

@implementation DGHarness

- (void)userContentController:(WKUserContentController *)ucc didReceiveScriptMessage:(WKScriptMessage *)message {
  if (![message.body isKindOfClass:NSDictionary.class]) return;
  // Numbered, so a verifier that seeds from `messages` and then hears the pushed events can tell
  // one it already has from a new one.
  NSMutableDictionary *m = [message.body mutableCopy];
  // The harness's word, on every message, and never the page's: trusted only when the engine's
  // event said so in the harness's own world. Anything posted on `dgharness` is something the page
  // SAID, kept as that whatever it claimed.
  // `@YES`/`@NO` and not `@(a && b)`, which boxes a C int and reaches JSON as 1 or 0.
  m[@"trusted"] = ([message.name isEqualToString:@"dgsecurity"] && [m[@"trusted"] isEqual:@YES]) ? @YES : @NO;
  m[@"seq"] = @(self.messages.count);
  [self.messages addObject:m];
  // Pushed as it happens too, so the verifier's side can answer "was this logged?" at once.
  [self send:@{@"event" : @"message", @"message" : m}];
}

- (void)send:(NSDictionary *)object {
  if (!self.out) return;
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  if (!data) return;
  NSMutableData *line = [data mutableCopy];
  [line appendBytes:"\n" length:1];
  @try {
    [self.out writeData:line];
  } @catch (NSException *e) {
    // The verifier let go of the channel. That ends the conversation, not the review: the window
    // still decides, closes or is killed at the caller's deadline. (`SIGPIPE` is ignored, below.)
    self.out = nil;
  }
}

- (void)start:(NSString *)dir {
  // A harness host outlives nobody. A killed run re-parents it to launchd, and then it exits --
  // SAYING so first, because a verifier checking that its caller killed the window must be able to
  // tell that from the window leaving on its own (`e2e.ts`'s timeout flow).
  pid_t parent = getppid();
  [NSTimer scheduledTimerWithTimeInterval:0.5
                                  repeats:YES
                                    block:^(NSTimer *t) {
                                      if (getppid() == parent) return;
                                      [self send:@{@"event" : @"orphaned"}];
                                      exit(3);
                                    }];
  NSString *inPath = [dir stringByAppendingPathComponent:@"in"];
  NSString *outPath = [dir stringByAppendingPathComponent:@"out"];
  [NSThread detachNewThreadWithBlock:^{
    // Each open blocks until the other end opens, which is the handshake.
    NSFileHandle *fin = [NSFileHandle fileHandleForReadingAtPath:inPath];
    NSFileHandle *fout = [NSFileHandle fileHandleForWritingAtPath:outPath];
    if (!fin || !fout) {
      fprintf(stderr, "draftgate-surface: harness channel %s could not be opened\n", dir.UTF8String);
      exit(3);
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      self.out = fout;
      [self send:@{@"event" : @"ready"}];
    });
    NSMutableData *buffer = [NSMutableData new];
    for (;;) {
      NSData *chunk = fin.availableData;
      // The verifier closed its end -- often straight after sending a click, which is still queued
      // on the main thread. Stop READING, and exit only after a grace: at once, that click never
      // lands; never, and a drive that failed against a wedged page leaves the window up for the
      // caller's whole review deadline.
      if (chunk.length == 0) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
          exit(3);
        });
        break;
      }
      [buffer appendData:chunk];
      for (;;) {
        NSRange nl = [buffer rangeOfData:[NSData dataWithBytes:"\n" length:1]
                                 options:0
                                   range:NSMakeRange(0, buffer.length)];
        if (nl.location == NSNotFound) break;
        NSData *line = [buffer subdataWithRange:NSMakeRange(0, nl.location)];
        [buffer replaceBytesInRange:NSMakeRange(0, nl.location + 1) withBytes:NULL length:0];
        dispatch_async(dispatch_get_main_queue(), ^{ [self handle:line]; });
      }
    }
  }];
}

// MARK: commands

- (void)handle:(NSData *)line {
  NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
  if (![cmd isKindOfClass:NSDictionary.class] || ![cmd[@"id"] isKindOfClass:NSNumber.class] ||
      ![cmd[@"op"] isKindOfClass:NSString.class]) {
    return;
  }
  NSNumber *identifier = cmd[@"id"];
  NSString *op = cmd[@"op"];
  void (^ok)(id) = ^(id value) { [self send:@{@"id" : identifier, @"ok" : @YES, @"value" : DGJSONSafe(value)}]; };
  void (^fail)(NSString *) = ^(NSString *error) { [self send:@{@"id" : identifier, @"ok" : @NO, @"error" : error}]; };
  DGHost *host = self.host;
  DGWebView *web = host.webView;
  DGWindow *win = host.window;

  if ([op isEqualToString:@"eval"]) {
    // The value is JSON-encoded IN the page, so nothing depends on how WebKit converts a JS value.
    NSString *body = [NSString stringWithFormat:@"return JSON.stringify(await (%@));", cmd[@"expr"] ?: @"undefined"];
    [web callAsyncJavaScript:body
                   arguments:@{}
                     inFrame:nil
              inContentWorld:WKContentWorld.pageWorld
           completionHandler:^(id result, NSError *error) {
             if (error) {
               fail(error.userInfo[@"WKJavaScriptExceptionMessage"] ?: error.localizedDescription);
             } else {
               ok([result isKindOfClass:NSString.class] ? result : nil);
             }
           }];
    return;
  }
  if ([op isEqualToString:@"reload"]) {
    // Answered when THIS load finishes, which is what the probe waits for -- matched by navigation,
    // so the first load's finish, still in flight when the reload is asked for, cannot answer it.
    WKNavigation *navigation = [host reloadForHarness];
    if (!navigation) return fail(@"the reload started no navigation");
    [self.pendingReloads addObject:@{@"id" : identifier, @"navigation" : navigation}];
    return;
  }
  if ([op isEqualToString:@"viewport"]) {
    // The viewport, as near as AppKit has one: the window's content size. There is no
    // device-pixel-ratio control; a snapshot is taken at the screen's scale.
    // No fallback size: every caller names both (`wkSession.ts`'s `VIEWPORT`), and a second copy of
    // it here would be the one nobody updates.
    double w = [cmd[@"width"] doubleValue], h = [cmd[@"height"] doubleValue];
    if (w <= 0 || h <= 0) return fail(@"viewport needs a width and a height");
    [win setContentSize:NSMakeSize(w, h)];
    ok(@{@"width" : @(web.frame.size.width), @"height" : @(web.frame.size.height)});
    return;
  }
  if ([op isEqualToString:@"snapshot"]) {
    // The view's pixels, drawn down to 1x (the scale the probe's
    // pictures are taken at).
    WKSnapshotConfiguration *cfg = [WKSnapshotConfiguration new];
    cfg.afterScreenUpdates = YES;
    [web takeSnapshotWithConfiguration:cfg
                     completionHandler:^(NSImage *image, NSError *error) {
                       if (!image) return fail(error.localizedDescription ?: @"no snapshot");
                       NSSize size = web.bounds.size;
                       NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
                           initWithBitmapDataPlanes:NULL pixelsWide:(NSInteger)size.width pixelsHigh:(NSInteger)size.height
                                      bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
                                     colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
                       rep.size = size;
                       [NSGraphicsContext saveGraphicsState];
                       NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
                       [image drawInRect:NSMakeRect(0, 0, size.width, size.height)];
                       [NSGraphicsContext restoreGraphicsState];
                       NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                       ok(@{@"png1x" : [png base64EncodedStringWithOptions:0] ?: @""});
                     }];
    return;
  }
  if ([op isEqualToString:@"state"]) {
    // `_webProcessIdentifier` is WebKit SPI, used here and nowhere in the review build: the one
    // way to name the WebContent process a crash check must kill.
    id webProcess = nil;
    @try {
      webProcess = [web valueForKey:@"_webProcessIdentifier"];
    } @catch (NSException *e) {
    }
    ok(@{
      @"webProcess" : DGJSONSafe(webProcess),
      @"hostLevel" : @(hostLevel),
      @"hostCollectionBehavior" : @(hostCollectionBehavior),
      @"title" : win.title,
      // The PAGE's title as WebKit holds it, so a check can tell "the page never retitled itself"
      // from "it did, and the window kept its own".
      @"pageTitle" : web.title ?: @"",
      @"pageZoom" : @(web.pageZoom),
      @"zoomLevel" : @(host.zoomLevel),
      @"inspectable" : @(web.inspectable),
      @"allowsLinkPreview" : @(web.allowsLinkPreview),
      @"allowsMagnification" : @(web.allowsMagnification),
      @"persistentStore" : @(web.configuration.websiteDataStore.persistent),
      // Which bundle the loader actually launched, so its AppKit defaults domain: the harness's own.
      @"bundleId" : NSBundle.mainBundle.bundleIdentifier ?: @"",
      @"menusOpened" : @(self.menusOpened),
      @"lastMenu" : DGJSONSafe(self.lastMenu),
    });
    return;
  }
  if ([op isEqualToString:@"messages"]) {
    ok(self.messages);
    return;
  }
  if ([op isEqualToString:@"menus"]) {
    NSMutableArray *menus = [NSMutableArray new];
    for (NSMenuItem *holder in NSApp.mainMenu.itemArray) {
      NSMutableArray *items = [NSMutableArray new];
      for (NSMenuItem *item in holder.submenu.itemArray) {
        if (item.isSeparatorItem) continue;
        [items addObject:@{
          @"title" : item.title,
          @"key" : item.keyEquivalent,
          @"modifiers" : @(item.keyEquivalentModifierMask),
          @"ours" : @(item.tag == DGMenuTag),
        }];
      }
      [menus addObject:@{@"title" : holder.submenu.title ?: @"", @"items" : items}];
    }
    ok(menus);
    return;
  }
  if ([op isEqualToString:@"key"]) {
    NSEvent *event = [self keyEvent:cmd window:win];
    if (!event) return fail([NSString stringWithFormat:@"unmapped key %@", cmd[@"key"]]);
    // To the window's own first responder, as a keystroke from the keyboard goes: every window comes
    // forward through the host's `-show`, which makes it the web view, and pinning it here again
    // would hide a window that had handed the keyboard elsewhere.
    // `app` goes through NSApplication, where a MENU's key equivalent is matched first: the path a
    // reviewer's Cmd+Z or Cmd+Plus takes. `window` goes to the window alone.
    if ([cmd[@"via"] isEqual:@"app"]) {
      [NSApp sendEvent:event];
    } else {
      [win sendEvent:event];
    }
    ok(nil);
    return;
  }
  if ([op isEqualToString:@"insertText"]) {
    [win makeFirstResponder:web];
    // NSResponder's `insertText:`, the path an input method commits through: text arriving as
    // typed text, without a keystroke per character.
    [web insertText:cmd[@"text"] ?: @""];
    ok(nil);
    return;
  }
  if ([op isEqualToString:@"rightClick"] || [op isEqualToString:@"click"]) {
    // A click at a point in the page's own coordinates, through the window as a mouse's arrives:
    // it lands on whatever is topmost there, with the mousedown a synthetic `el.click()` skips.
    // For a right-click, if a context menu opens anyway, `DGHarnessMenuWillOpen` records it and
    // cancels its tracking, so a regression is a failed check rather than a menu left up on
    // somebody's screen.
    BOOL right = [op isEqualToString:@"rightClick"];
    NSPoint p = [web convertPoint:NSMakePoint([cmd[@"x"] doubleValue], [cmd[@"y"] doubleValue]) toView:nil];
    NSArray<NSNumber *> *types = right ? @[ @(NSEventTypeRightMouseDown), @(NSEventTypeRightMouseUp) ]
                                       : @[ @(NSEventTypeLeftMouseDown), @(NSEventTypeLeftMouseUp) ];
    for (NSNumber *type in types) {
      NSEvent *e = [NSEvent mouseEventWithType:(NSEventType)type.unsignedIntegerValue
                                      location:p
                                 modifierFlags:0
                                     timestamp:NSProcessInfo.processInfo.systemUptime
                                  windowNumber:win.windowNumber
                                       context:nil
                                   eventNumber:0
                                    clickCount:1
                                      pressure:type.integerValue == types[0].integerValue ? 1 : 0];
      [win sendEvent:e];
    }
    ok(nil);
    return;
  }
  if ([op isEqualToString:@"close"]) {
    [win performClose:nil];
    ok(nil);
    return;
  }
  if ([op isEqualToString:@"show"]) {
    // The host's own `-show`, for a window whose channel asked to bring it forward itself
    // (`DGHarnessShowsWhenAsked`): what a review does when its page has loaded, minus activating.
    [host show];
    ok(nil);
    return;
  }
  if ([op isEqualToString:@"becomeKey"]) {
    // The step a review's window takes when the app's activation lands, about 0.4 s after `-show`:
    // AppKit makes it key and tells it so. See `DGWindow (Harness)`.
    standsInForKey = YES;
    [win becomeKeyWindow];
    ok(nil);
    return;
  }
  fail([NSString stringWithFormat:@"unknown op %@", op]);
}

// A key the verifier names, as an AppKit key event: one character, or one of the named keys the
// verifiers press. `modifiers` holds the bits `MODIFIER` in `surface/harness/wkSession.ts` defines.
- (nullable NSEvent *)keyEvent:(NSDictionary *)cmd window:(NSWindow *)win {
  NSString *key = [cmd[@"key"] isKindOfClass:NSString.class] ? cmd[@"key"] : @"";
  NSDictionary<NSString *, NSArray *> *named = @{
    @"Enter" : @[ @36, @"\r" ],
    @"Backspace" : @[ @51, @"\x7f" ],
    @"Tab" : @[ @48, @"\t" ],
    @"Escape" : @[ @53, @"\x1b" ],
    // An arrow key arrives from the keyboard with these two flags set, and AppKit's key bindings
    // read them.
    @"ArrowUp" : @[ @126, [NSString stringWithFormat:@"%C", (unichar)NSUpArrowFunctionKey],
                    @(NSEventModifierFlagFunction | NSEventModifierFlagNumericPad) ],
  };
  unsigned short code = 0;
  NSString *chars = key;
  NSEventModifierFlags flags = 0;
  if (named[key]) {
    code = [named[key][0] unsignedShortValue];
    chars = named[key][1];
    if (named[key].count > 2) flags = [named[key][2] unsignedIntegerValue];
  } else if (key.length != 1) {
    return nil;
  }
  NSInteger m = [cmd[@"modifiers"] integerValue];
  if (m & 1) flags |= NSEventModifierFlagOption;
  if (m & 2) flags |= NSEventModifierFlagControl;
  if (m & 4) flags |= NSEventModifierFlagCommand;
  if (m & 8) flags |= NSEventModifierFlagShift;
  NSEventType type = [cmd[@"type"] isEqual:@"keyUp"] ? NSEventTypeKeyUp : NSEventTypeKeyDown;
  return [NSEvent keyEventWithType:type
                          location:NSZeroPoint
                     modifierFlags:flags
                         timestamp:NSProcessInfo.processInfo.systemUptime
                      windowNumber:win.windowNumber
                           context:nil
                        characters:chars
       charactersIgnoringModifiers:chars
                         isARepeat:NO
                           keyCode:code];
}

@end

void DGHarnessConfigure(WKWebViewConfiguration *config) {
  harness = [DGHarness new];
  harness.messages = [NSMutableArray new];
  harness.pendingReloads = [NSMutableArray new];
  WKUserContentController *ucc = config.userContentController;
  [ucc addScriptMessageHandler:harness contentWorld:WKContentWorld.pageWorld name:@"dgharness"];
  [ucc addUserScript:[[WKUserScript alloc] initWithSource:CAPTURE_SCRIPT
                                            injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                         forMainFrameOnly:YES
                                           inContentWorld:WKContentWorld.pageWorld]];
  WKContentWorld *securityWorld = [WKContentWorld worldWithName:@"dgharness-security"];
  [ucc addScriptMessageHandler:harness contentWorld:securityWorld name:@"dgsecurity"];
  [ucc addUserScript:[[WKUserScript alloc] initWithSource:SECURITY_SCRIPT
                                            injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                         forMainFrameOnly:YES
                                           inContentWorld:securityWorld]];
}

void DGHarnessPlace(DGWindow *w) {
  // What the host asked for, before this lowers it: the one reading of `alwaysOnTop` -- and of the
  // desktops it joins -- that a window nobody can see still allows.
  hostLevel = w.level;
  hostCollectionBehavior = w.collectionBehavior;
  // And on the one desktop it opened on, where a review's window joins every one: a window that is
  // never for a person has no business on the others, or over a full-screen app.
  w.collectionBehavior = NSWindowCollectionBehaviorDefault;
  w.unconstrained = YES;
  w.ignoresMouseEvents = YES;
  w.level = NSNormalWindowLevel;
  [w setFrameOrigin:NSMakePoint(-30000, -30000)];
  // And all but transparent, for whatever might still bring it on screen -- a display plugged in or
  // out, Mission Control. Nothing measured reads the window's own pixels: a snapshot is the web
  // view's, and with occlusion detection off, WebKit draws at any opacity.
  w.alphaValue = 0.01;
  // NOT ordered in here: the host's `-show` does that, as a review's does. See the header.
}

// See the header: WebKit must not decide this window is occluded. Called once the web view exists.
static void DGHarnessKeepDrawing(WKWebView *web) {
  SEL sel = NSSelectorFromString(@"_setWindowOcclusionDetectionEnabled:");
  if (![web respondsToSelector:sel]) {
    // Loud rather than silent: without it every frame-dependent check fails for a reason that is
    // not its own. `surface:host`'s preflight names this too.
    fprintf(stderr, "draftgate-surface: this WebKit has no _setWindowOcclusionDetectionEnabled:, so an off-screen "
                    "harness window will not draw\n");
    return;
  }
  ((void (*)(id, SEL, BOOL))objc_msgSend)(web, sel, NO);
}

// The channel directory: the harness's FIFOs, and its own placement file beside them.
static NSString *DGHarnessDir(void) { return NSProcessInfo.processInfo.environment[@"DRAFTGATE_HARNESS"]; }

void DGHarnessStart(DGHost *host) {
  harness.host = host;
  DGHarnessKeepDrawing(host.webView);
  // A write to a channel nobody reads any more must fail, not kill the window by signal.
  signal(SIGPIPE, SIG_IGN);
  NSString *dir = DGHarnessDir();
  if (!dir) {
    fprintf(stderr, "draftgate-surface: a harness build needs DRAFTGATE_HARNESS\n");
    exit(3);
  }
  [harness start:dir];
}

void DGHarnessLoaded(WKNavigation *navigation) {
  NSMutableArray *answered = [NSMutableArray new];
  for (NSDictionary *pending in harness.pendingReloads) {
    if (pending[@"navigation"] != navigation) continue;
    [harness send:@{@"id" : pending[@"id"], @"ok" : @YES, @"value" : NSNull.null}];
    [answered addObject:pending];
  }
  [harness.pendingReloads removeObjectsInArray:answered];
}

NSString *DGHarnessWindowStatePath(void) { return [DGHarnessDir() stringByAppendingPathComponent:@"window.json"]; }

// A file the verifier writes into the channel directory before it spawns the window, so the answer
// is there before the load can finish: an op would race it. A window that waits draws its page
// unseen and comes forward onto controls that already exist. Whether a review's page has drawn by
// its load event is a race, and the focus rule in `-show` must hold whichever way it goes.
BOOL DGHarnessShowsWhenAsked(void) {
  NSString *marker = [DGHarnessDir() stringByAppendingPathComponent:@"show-when-asked"];
  return [NSFileManager.defaultManager fileExistsAtPath:marker];
}

void DGHarnessMenuWillOpen(NSMenu *menu) {
  harness.menusOpened += 1;
  NSMutableArray *items = [NSMutableArray new];
  for (NSMenuItem *item in menu.itemArray) [items addObject:item.identifier ?: item.title];
  harness.lastMenu = items;
  [menu performSelector:@selector(cancelTrackingWithoutAnimation)
             withObject:nil
             afterDelay:0.2
                inModes:@[ NSRunLoopCommonModes ]];
}

#endif
