// draftgate's review window on the system WebKit.
//
// It does one job for the `surface/dist` bundle: read the request, serve the bundle over
// `draftgate://` under the real CSP, expose the two bridge functions to the main frame, and write
// exactly one decision. It is Objective-C, not Swift, because the host is compiled on the
// reviewer's own Mac, at install and whenever this source changes: a cold Swift build of the same
// frameworks measured 36 s and a 232 MB module cache, against 0.43 s in Objective-C.
//
// `request.cjs`, `rendererBridge.cjs` (the decision allow-list), `geometry.cjs` (placement and zoom)
// and `windowTitle.cjs` run unchanged in a JavaScriptCore context here, loaded by a `require` that
// reaches only their sibling files. No rule is restated in this file.
//
// Exit: a clean exit with no decision file is the reviewer closing the window (a rejection); a
// non-zero exit (malformed request, failed load, crashed WebContent) is `unavailable`, naming the
// line written to stderr (`cli/src/surfaces/window.ts`). Never an approval.
//
// The window renders agent-authored content, so: the CSP as a real header, every navigation this
// process did not start cancelled, no new windows, every permission denied, no inspector, no
// context menu, no link previews, nothing persisted, and the decision validated before it is written.

#import "host.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static NSString *const SCHEME = @"draftgate";

#ifdef DG_HARNESS
static const BOOL HARNESS = YES;
#else
static const BOOL HARNESS = NO;
#endif

// The prefix the CLI quotes when a window fails.
static void DGLog(NSString *line) { fprintf(stderr, "draftgate-surface: %s\n", line.UTF8String); }

__attribute__((noreturn)) static void DGDie(NSString *line) {
  DGLog(line);
  exit(1);
}

// MARK: - The pure CommonJS modules, in JavaScriptCore

@interface DGModules : NSObject
@property(nonatomic, readonly) JSValue *contract;
- (instancetype)initWithSurface:(NSURL *)surface;
- (nullable JSValue *)call:(NSString *)file
                        fn:(NSString *)name
                      args:(NSArray *)args
                   failure:(NSString *_Nullable *_Nullable)failure;
- (nullable JSValue *)parse:(NSString *)json;
- (nullable NSString *)stringify:(JSValue *)value;
@end

@implementation DGModules {
  JSContext *_ctx;
  NSURL *_surface;
  NSMutableDictionary<NSString *, JSValue *> *_loaded;
  JSValue *_require;
}

- (instancetype)initWithSurface:(NSURL *)surface {
  if (!(self = [super init])) return nil;
  _surface = surface;
  _loaded = [NSMutableDictionary new];
  _ctx = [JSContext new];
  __weak DGModules *weak = self;
  // A module's `require`. JavaScriptCore rethrows into the calling script whatever this leaves in
  // `ctx.exception`, so a module that fails to load fails the one that asked for it.
  _require = [JSValue valueWithObject:^JSValue *(NSString *name) { return [weak require:name]; }
                            inContext:_ctx];
  _contract = [self parse:[self read:@"contract.json"]];
  if (!_contract.isObject) DGDie(@"contract.json is not a JSON object");
  return self;
}

- (NSString *)read:(NSString *)file {
  NSString *text = [NSString stringWithContentsOfURL:[_surface URLByAppendingPathComponent:file]
                                            encoding:NSUTF8StringEncoding
                                               error:nil];
  if (!text) DGDie([NSString stringWithFormat:@"cannot read %@ in %@", file, _surface.path]);
  return text;
}

// The message of whatever the context threw, cleared so the next call starts clean.
- (nullable NSString *)takeException {
  JSValue *e = _ctx.exception;
  if (!e) return nil;
  _ctx.exception = nil;
  JSValue *message = e.isObject ? e[@"message"] : nil;
  return message.isString ? message.toString : e.toString;
}

// `./name.cjs`, a sibling of this surface's own modules, and nothing else: these modules import
// only each other, and a module that grew any other import fails here loudly rather than
// half-loading.
- (JSValue *)require:(NSString *)name {
  NSString *file = [name hasPrefix:@"./"] ? [name substringFromIndex:2] : @"";
  NSCharacterSet *bad = [NSCharacterSet characterSetWithCharactersInString:@"/\\"];
  if (![file hasSuffix:@".cjs"] || [file rangeOfCharacterFromSet:bad].location != NSNotFound) {
    _ctx.exception = [JSValue
        valueWithNewErrorFromMessage:[NSString stringWithFormat:@"require(%@) is not available in the host", name]
                           inContext:_ctx];
    return [JSValue valueWithUndefinedInContext:_ctx];
  }
  JSValue *module = _loaded[file];
  if (module) return module[@"exports"];
  module = [JSValue valueWithNewObjectInContext:_ctx];
  module[@"exports"] = [JSValue valueWithNewObjectInContext:_ctx];
  _loaded[file] = module;
  NSString *source = [NSString stringWithFormat:@"(function (module, exports, require) {\n%@\n})", [self read:file]];
  JSValue *fn = [_ctx evaluateScript:source withSourceURL:[_surface URLByAppendingPathComponent:file]];
  if (!_ctx.exception) [fn callWithArguments:@[ module, module[@"exports"], _require ]];
  return module[@"exports"];
}

- (JSValue *)module:(NSString *)file {
  JSValue *exports = [self require:[@"./" stringByAppendingString:file]];
  NSString *failure = [self takeException];
  if (failure) DGDie([NSString stringWithFormat:@"%@: %@", file, failure]);
  return exports;
}

- (nullable JSValue *)call:(NSString *)file
                        fn:(NSString *)name
                      args:(NSArray *)args
                   failure:(NSString *_Nullable *_Nullable)failure {
  JSValue *value = [[self module:file][name] callWithArguments:args];
  NSString *thrown = [self takeException];
  if (failure) *failure = thrown;
  return thrown ? nil : value;
}

- (nullable JSValue *)parse:(NSString *)json {
  JSValue *value = [_ctx[@"JSON"] invokeMethod:@"parse" withArguments:@[ json ]];
  return [self takeException] ? nil : value;
}

- (nullable NSString *)stringify:(JSValue *)value {
  JSValue *text = [_ctx[@"JSON"] invokeMethod:@"stringify" withArguments:@[ value ]];
  return [self takeException] || !text.isString ? nil : text.toString;
}

@end

// MARK: - Coordinates: geometry.cjs's (top-left of the primary display, y down) and AppKit's

// `geometry.cjs` speaks top-left coordinates and `window.json` is written in them, so every
// rectangle crosses this boundary through these two functions.
static CGFloat DGPrimaryHeight(void) { return NSScreen.screens.firstObject.frame.size.height; }

static NSDictionary *DGTopLeftRect(NSRect r) {
  return @{
    @"x" : @(NSMinX(r)),
    @"y" : @(DGPrimaryHeight() - NSMaxY(r)),
    @"width" : @(NSWidth(r)),
    @"height" : @(NSHeight(r)),
  };
}

static BOOL DGAppKitRect(id value, NSRect *out) {
  if (![value isKindOfClass:NSDictionary.class]) return NO;
  NSDictionary *o = value;
  for (NSString *key in @[ @"x", @"y", @"width", @"height" ]) {
    if (![o[key] isKindOfClass:NSNumber.class]) return NO;
  }
  double x = [o[@"x"] doubleValue], y = [o[@"y"] doubleValue];
  double w = [o[@"width"] doubleValue], h = [o[@"height"] doubleValue];
  *out = NSMakeRect(x, DGPrimaryHeight() - y - h, w, h);
  return YES;
}

// MARK: - The web view: no context menu, no Services

// The window shows no context menu. WebKit's own has Reload (discards the reviewer's edits), Open
// Link and Download Image (a fetch to a host the agent chose, outside the CSP), and AppKit adds
// AutoFill, Continuity Camera and Services AFTER `willOpenMenu:` runs, so emptying it there is not
// enough. `NO_CONTEXT_MENU` below cancels the page's `contextmenu` event in every frame, so no menu
// is built; `willOpenMenu:` is what is left if one is built anyway. `validRequestorForSendType:`
// returning nil would also switch off the app menu's Services, which the window keeps.

@implementation DGWebView

- (void)willOpenMenu:(NSMenu *)menu withEvent:(NSEvent *)event {
#ifdef DG_HARNESS
  DGHarnessMenuWillOpen(menu);
#endif
  [menu removeAllItems];
}

@end

@implementation DGWindow

- (NSRect)constrainFrameRect:(NSRect)rect toScreen:(nullable NSScreen *)screen {
  return self.unconstrained ? rect : [super constrainFrameRect:rect toScreen:screen];
}

@end

// MARK: - Serving the bundle

@interface DGSchemeHandler : NSObject <WKURLSchemeHandler>
- (instancetype)initWithDist:(NSURL *)dist csp:(NSString *)csp;
@end

@implementation DGSchemeHandler {
  NSURL *_dist;
  NSString *_csp;
}

- (instancetype)initWithDist:(NSURL *)dist csp:(NSString *)csp {
  if (!(self = [super init])) return nil;
  _dist = dist.URLByStandardizingPath;
  _csp = csp;
  return self;
}

static NSString *DGMime(NSString *extension) {
  NSDictionary *types = @{
    @"html" : @"text/html; charset=utf-8",
    @"js" : @"text/javascript; charset=utf-8",
    @"css" : @"text/css; charset=utf-8",
    @"json" : @"application/json; charset=utf-8",
    @"svg" : @"image/svg+xml",
    @"woff2" : @"font/woff2",
    @"png" : @"image/png",
  };
  return types[extension] ?: @"application/octet-stream";
}

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
  NSURL *url = task.request.URL;
  NSString *path = url.path ?: @""; // already percent-decoded
  NSURL *file = ([path isEqualToString:@"/"] || path.length == 0)
                    ? [_dist URLByAppendingPathComponent:@"index.html"]
                    : [_dist URLByAppendingPathComponent:path].URLByStandardizingPath;
  // Path traversal: the request URL comes from a process rendering hostile content.
  NSString *root = _dist.path;
  if (!([file.path isEqualToString:root] || [file.path hasPrefix:[root stringByAppendingString:@"/"]])) {
    [self respond:task status:403 body:[@"forbidden" dataUsingEncoding:NSUTF8StringEncoding] type:@"text/plain"];
    return;
  }
  NSData *body = [NSData dataWithContentsOfURL:file];
  if (!body) {
    // A missing file FAILS its request rather than answering 404. For the document, a 404 is a
    // "not found" page a reviewer could only close, and closing is a rejection; failing it fails
    // the load, which exits (`navigation:failed:`) and is `unavailable`. For anything else the page
    // sees a failed load either way.
    [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain
                                               code:NSURLErrorFileDoesNotExist
                                           userInfo:@{NSLocalizedDescriptionKey : @"the built window is missing a file"}]];
    return;
  }
  [self respond:task status:200 body:body type:DGMime(file.pathExtension)];
}

- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {
  // Every task is answered synchronously in `start`, so there is nothing to stop.
}

- (void)respond:(id<WKURLSchemeTask>)task status:(NSInteger)status body:(NSData *)body type:(NSString *)type {
  NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
       initWithURL:task.request.URL
        statusCode:status
       HTTPVersion:@"HTTP/1.1"
      headerFields:@{
        @"Content-Type" : type,
        @"Content-Security-Policy" : _csp,
        @"X-Content-Type-Options" : @"nosniff",
        @"Content-Length" : [NSString stringWithFormat:@"%lu", (unsigned long)body.length],
      }];
  [task didReceiveResponse:response];
  [task didReceiveData:body];
  [task didFinish];
}

@end

// MARK: - The page's scripts

// The page's two bridge functions, defined at document start in the MAIN FRAME only, non-writable,
// with `JSON` captured before any page script runs. The decision crosses as a STRING, so this
// process parses it in its own context rather than trusting WebKit's object conversion.
//
// The raw handler, `window.webkit.messageHandlers.draftgate`, is visible to page script in EVERY
// frame -- `forMainFrameOnly` scopes this wrapper and not the handler -- which is why the host's own
// frame check below is load-bearing (`surface:host` drives a subframe at both and watches it get
// nothing).
static NSString *const BRIDGE_SCRIPT = @"(() => {\n"
                                        "  const handler = window.webkit.messageHandlers.draftgate;\n"
                                        "  const post = handler.postMessage.bind(handler);\n"
                                        "  const parse = JSON.parse, stringify = JSON.stringify;\n"
                                        "  const draftgate = Object.freeze({\n"
                                        "    request: () => post({ kind: 'request' })\n"
                                        "      .then((json) => (typeof json === 'string' ? parse(json) : null)),\n"
                                        "    decide: (decision) => { post({ kind: 'decide', json: stringify(decision) }); },\n"
                                        "  });\n"
                                        "  Object.defineProperty(window, 'draftgate',\n"
                                        "    { value: draftgate, writable: false, configurable: false });\n"
                                        "})();\n";

// See `DGWebView`. Registered first, at document start, in every frame, on the window's capture
// phase -- before anything the page could add -- and unreachable afterwards, so nothing can remove
// it.
static NSString *const NO_CONTEXT_MENU =
    @"window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });\n";

// MARK: - The host

@interface DGHost () <NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
                      WKScriptMessageHandlerWithReply>
@end

@implementation DGHost {
  NSURL *_surface;
  DGModules *_modules;
  NSString *_requestText;
  NSString *_destination;
  id _toolName;
  NSString *_decisionPath;
  NSString *_windowStatePath;
  BOOL _written;
  BOOL _shown;
  // The one navigation this process starts. Every other is cancelled, and only this one failing
  // is a failed load.
  BOOL _loadAllowed;
  WKNavigation *_load;
  // The window's last frame that was neither zoomed nor full screen.
  NSRect _normalFrame;
}

- (instancetype)initWithSurface:(NSURL *)surface environment:(NSDictionary<NSString *, NSString *> *)env {
  if (!(self = [super init])) return nil;
  _surface = surface;
  // The three variables the CLI sets, and no others: `surface/harness/host.test.ts` holds this
  // file to exactly these.
  NSString *requestPath = env[@"DRAFTGATE_REQUEST"];
  _decisionPath = env[@"DRAFTGATE_DECISION"];
#ifdef DG_HARNESS
  // NEVER the reviewer's placement: where a driven window ends up is nobody's choice, and a
  // harness run writing the live `window.json` would move the reviewer's next window. A harness
  // tests the same save and restore on a scratch file inside its own channel directory.
  _windowStatePath = DGHarnessWindowStatePath();
#else
  _windowStatePath = env[@"DRAFTGATE_WINDOW_STATE"];
#endif

  _modules = [[DGModules alloc] initWithSurface:surface];
  // Before any window exists: a malformed request is fatal.
  if (!requestPath) DGDie(@"DRAFTGATE_REQUEST is not set");
  NSString *text = [NSString stringWithContentsOfFile:requestPath encoding:NSUTF8StringEncoding error:nil];
  if (!text) DGDie([NSString stringWithFormat:@"cannot read %@", requestPath]);
  NSString *failure = nil;
  JSValue *request = [_modules call:@"request.cjs" fn:@"parseRequest" args:@[ text, _modules.contract ] failure:&failure];
  if (!request) DGDie(failure ?: @"the request could not be read");
  _requestText = text;
  _destination = request[@"destination"].toString;
  JSValue *tool = request[@"toolName"];
  _toolName = tool.isString ? tool.toString : NSNull.null;
  return self;
}

// MARK: lifecycle

- (void)applicationDidFinishLaunching:(NSNotification *)note {
  [self installMenu];

  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  NSString *csp = _modules.contract[@"csp"].toString;
  NSURL *dist = [_surface URLByAppendingPathComponent:@"dist" isDirectory:YES];
  [config setURLSchemeHandler:[[DGSchemeHandler alloc] initWithDist:dist csp:csp] forURLScheme:SCHEME];
  // Nothing persists, in a review as in a harness run: no cookies from an image the reviewer chose
  // to load, no cache, no storage. `localStorage` on `draftgate://` does not survive a relaunch
  // in any data store tried, so a persistent store would keep only the things this window has no
  // business keeping.
  config.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
  config.preferences.javaScriptCanOpenWindowsAutomatically = NO;
  // A Safe Browsing lookup is a network request about a URL the agent chose.
  config.preferences.fraudulentWebsiteWarningEnabled = NO;
  config.preferences.elementFullscreenEnabled = NO;
  config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeAll;

  WKUserContentController *ucc = config.userContentController;
  [ucc addScriptMessageHandlerWithReply:self contentWorld:WKContentWorld.pageWorld name:@"draftgate"];
  [ucc addUserScript:[[WKUserScript alloc] initWithSource:NO_CONTEXT_MENU
                                            injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                         forMainFrameOnly:NO
                                           inContentWorld:WKContentWorld.pageWorld]];
  [ucc addUserScript:[[WKUserScript alloc] initWithSource:BRIDGE_SCRIPT
                                            injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                         forMainFrameOnly:YES
                                           inContentWorld:WKContentWorld.pageWorld]];
#ifdef DG_HARNESS
  DGHarnessConfigure(config);
#endif

  NSDictionary *workArea = [self workArea];
  NSRect frame = [self initialFrame:workArea];
  _window = [[DGWindow alloc] initWithContentRect:frame
                                        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                  NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                                          backing:NSBackingStoreBuffered
                                            defer:NO];
  [_window setFrame:frame display:NO]; // `frame` is the OUTER size, as `geometry.cjs`'s bounds are
  _normalFrame = frame;
  _window.releasedWhenClosed = NO;
  _window.restorable = NO;
  // Always on top: the review is blocking a send and must not get lost behind the terminal.
  _window.level = NSFloatingWindowLevel;
  // And for the same reason it is on whichever desktop you are on, over a full-screen app too: a
  // review left on a desktop you switched away from is a send nobody can find.
  _window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
  // The title bar keeps what `windowTitle.cjs` composed: a WKWebView never retitles its window, so
  // a page's own <title> cannot replace it.
  _window.title = [_modules call:@"windowTitle.cjs" fn:@"windowTitle" args:@[ _destination, _toolName ] failure:nil]
                      .toString ?: @"draftgate review";
  JSValue *floor = [_modules call:@"geometry.cjs" fn:@"minimumSize" args:@[ workArea ] failure:nil];
  _window.minSize = NSMakeSize(floor[@"width"].toDouble, floor[@"height"].toDouble);
#ifdef DG_HARNESS
  // After the level, which it lowers again, and before the delegate, so moving the window out of
  // sight is not remembered as a placement.
  DGHarnessPlace(_window);
#endif
  _window.delegate = self;

  _webView = [[DGWebView alloc] initWithFrame:_window.contentView.bounds configuration:config];
  _webView.navigationDelegate = self;
  _webView.UIDelegate = self;
  _webView.inspectable = NO;
  _webView.allowsBackForwardNavigationGestures = NO;
  _webView.allowsMagnification = NO;
  // A force click on a link opens a PREVIEW, which loads the link: a request to a host the agent
  // chose, at the reviewer's gesture but not at their decision.
  _webView.allowsLinkPreview = NO;
  _webView.pageZoom = [self zoomFactor];
  _window.contentView = _webView;
  // Its first responder is made in `-show`, before the window is ordered in: see there.

#ifdef DG_HARNESS
  DGHarnessStart(self);
#endif

  [self load];
}

- (void)load {
  _loadAllowed = YES;
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@://review/index.html", SCHEME]];
  _load = [_webView loadRequest:[NSURLRequest requestWithURL:url]];
}

#ifdef DG_HARNESS
- (WKNavigation *)reloadForHarness {
  _loadAllowed = YES;
  _load = [_webView reload];
  return _load;
}
#endif

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)app { return YES; }
- (BOOL)applicationSupportsSecureRestorableState:(NSApplication *)app { return YES; }
- (void)applicationWillTerminate:(NSNotification *)note { [self saveState]; }
- (void)windowWillClose:(NSNotification *)note { [self saveState]; }
- (void)windowDidMove:(NSNotification *)note { [self noteFrame]; }
- (void)windowDidResize:(NSNotification *)note { [self noteFrame]; }

// MARK: coming forward

// The window asks for the keyboard (a review blocks a send and has to be noticed) and focuses
// nothing in the page: the first click places the caret. Whether activation is granted is macOS's
// call: with another app in front it refuses, and the window floats while that app keeps the
// keyboard (`shortcutGrace.ts` has the measurement and what it means for `⌘↵`).
//
// The web view is made first responder directly, BEFORE the window is ordered in. A window with
// none gets one picked through the key-view loop, as a Tab would, and WebKit then focuses the
// page's first reachable control (the text-style select, a title), which catches stray typing.
//
// A harness window comes forward through this method too, so a verifier drives what a review shows.
// It skips the activation, which would take the keyboard from whoever is typing (`host.test.ts`
// reads the harness binary for that).
- (void)show {
  if (_shown) return;
  _shown = YES;
  [_window makeFirstResponder:_webView];
  [_window makeKeyAndOrderFront:nil];
#ifndef DG_HARNESS
  [NSApp activate];
#endif
}

// MARK: placement, through geometry.cjs

- (NSDictionary *)workArea {
  // The display the CURSOR is on: see `geometry.cjs` for why.
  NSPoint mouse = NSEvent.mouseLocation;
  NSScreen *screen = NSScreen.mainScreen;
  for (NSScreen *s in NSScreen.screens) {
    if (NSMouseInRect(mouse, s.frame, NO)) screen = s;
  }
  return DGTopLeftRect(screen.visibleFrame);
}

- (nullable NSDictionary *)savedState {
  if (!_windowStatePath) return nil;
  NSString *text = [NSString stringWithContentsOfFile:_windowStatePath encoding:NSUTF8StringEncoding error:nil];
  JSValue *saved = text ? [_modules parse:text] : nil;
  return saved.isObject ? saved.toDictionary : nil;
}

- (NSRect)initialFrame:(NSDictionary *)workArea {
  NSDictionary *saved = [self savedState];
  NSRect frame;
  if (saved) {
    _zoomLevel = [_modules call:@"geometry.cjs" fn:@"restoreZoomLevel" args:@[ saved ] failure:nil].toDouble;
    NSMutableArray *displays = [NSMutableArray new];
    for (NSScreen *s in NSScreen.screens) [displays addObject:@{@"workArea" : DGTopLeftRect(s.visibleFrame)}];
    JSValue *restored = [_modules call:@"geometry.cjs" fn:@"restoreBounds" args:@[ saved, displays ] failure:nil];
    if (restored.isObject && DGAppKitRect(restored.toDictionary, &frame)) return frame;
  }
  JSValue *bounds = [_modules call:@"geometry.cjs" fn:@"reviewWindowBounds" args:@[ workArea ] failure:nil];
  if (DGAppKitRect(bounds.toDictionary, &frame)) return frame;
  return NSMakeRect(100, 100, 1040, 860);
}

- (void)noteFrame {
  BOOL full = (_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  if (!full && !_window.isZoomed) _normalFrame = _window.frame;
}

// Remember where the reviewer put the window, and the zoom. It never throws: a review must not
// fail because a preference could not be written.
- (void)saveState {
  if (!_windowStatePath || !_window) return;
  JSValue *state = [_modules call:@"geometry.cjs" fn:@"windowState" args:@[ DGTopLeftRect(_normalFrame), @(_zoomLevel) ] failure:nil];
  NSData *data = [(state ? [_modules stringify:state] : nil) dataUsingEncoding:NSUTF8StringEncoding];
  if (!data) return;
  NSString *dir = _windowStatePath.stringByDeletingLastPathComponent;
  [NSFileManager.defaultManager createDirectoryAtPath:dir
                          withIntermediateDirectories:YES
                                           attributes:@{NSFilePosixPermissions : @0700}
                                                error:nil];
  [NSFileManager.defaultManager createFileAtPath:_windowStatePath
                                        contents:data
                                      attributes:@{NSFilePosixPermissions : @0600}];
}

// MARK: zoom: the View menu's three items, through geometry.cjs

- (double)zoomFactor {
  return [_modules call:@"geometry.cjs" fn:@"zoomFactor" args:@[ @(_zoomLevel) ] failure:nil].toDouble;
}

- (void)zoom:(NSString *)item {
  _zoomLevel = [_modules call:@"geometry.cjs" fn:@"zoomLevelAfter" args:@[ @(_zoomLevel), item ] failure:nil].toDouble;
  _webView.pageZoom = [self zoomFactor];
  [self saveState];
}

- (void)zoomReset:(id)sender { [self zoom:@"reset"]; }
- (void)zoomIn:(id)sender { [self zoom:@"in"]; }
- (void)zoomOut:(id)sender { [self zoom:@"out"]; }

// MARK: the bridge: the page's two calls, its frame check, and `writeDecision`

- (void)userContentController:(WKUserContentController *)ucc
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id _Nullable reply, NSString *_Nullable errorMessage))reply {
  // The `senderFrame` guard: this window's own top-level frame, on our own origin, and nobody
  // else. See `BRIDGE_SCRIPT` for why it is load-bearing.
  NSDictionary *body = [message.body isKindOfClass:NSDictionary.class] ? message.body : nil;
  NSString *kind = [body[@"kind"] isKindOfClass:NSString.class] ? body[@"kind"] : nil;
  BOOL ours = message.webView == _webView && message.frameInfo.isMainFrame &&
              [message.frameInfo.securityOrigin.protocol isEqualToString:SCHEME];
  if (!ours || !kind) {
    reply(nil, nil);
    return;
  }
  if ([kind isEqualToString:@"request"]) {
    reply(_requestText, nil);
    return;
  }
  reply(nil, nil);
  if ([kind isEqualToString:@"decide"]) {
    [self writeDecision:[body[@"json"] isKindOfClass:NSString.class] ? body[@"json"] : nil];
    [self saveState];
    exit(0);
  }
}

// Validated HERE, by `sanitiseDecision`. Unrecognised input writes nothing, and the absent file
// after a clean exit is a rejection.
- (void)writeDecision:(nullable NSString *)json {
  if (_written || !_decisionPath || !json) return;
  JSValue *raw = [_modules parse:json];
  if (!raw) return;
  NSString *failure = nil;
  JSValue *out = [_modules call:@"rendererBridge.cjs" fn:@"sanitiseDecision" args:@[ raw, _modules.contract ] failure:&failure];
  if (failure) {
    DGLog([NSString stringWithFormat:@"sanitiseDecision threw: %@", failure]);
    return;
  }
  NSString *text = out.isObject ? [_modules stringify:out] : nil;
  if (!text) return;
  NSError *error = nil;
  if ([text writeToFile:_decisionPath atomically:NO encoding:NSUTF8StringEncoding error:&error]) {
    _written = YES;
  } else {
    DGLog([NSString stringWithFormat:@"could not write the decision: %@", error.localizedDescription]);
  }
}

// MARK: navigation: every navigation this process did not start is cancelled

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decision {
  BOOL ours = action.targetFrame.isMainFrame && _loadAllowed && [action.request.URL.scheme isEqualToString:SCHEME];
  if (ours) _loadAllowed = NO;
  decision(ours ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
#ifdef DG_HARNESS
  DGHarnessLoaded(navigation);
  if (DGHarnessShowsWhenAsked()) return;
#endif
  [self show];
}

- (void)webView:(WKWebView *)webView
    didFailProvisionalNavigation:(WKNavigation *)navigation
                       withError:(NSError *)error {
  [self navigation:navigation failed:error];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  [self navigation:navigation failed:error];
}

// A navigation this host cancelled fails too, and that is the policy working. Only the load the
// host STARTED failing means there is no review to show.
- (void)navigation:(WKNavigation *)navigation failed:(NSError *)error {
  if (navigation != _load) return;
  DGDie([NSString stringWithFormat:@"load failed (%@ %ld %@)", error.domain, (long)error.code, error.localizedDescription]);
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  DGDie(@"renderer gone (WebContent terminated)");
}

// MARK: UI delegate: no windows, no permissions, no panels

- (nullable WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)config
               forNavigationAction:(WKNavigationAction *)action
                    windowFeatures:(WKWindowFeatures *)features {
  return nil;
}

- (void)webView:(WKWebView *)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
                          initiatedByFrame:(WKFrameInfo *)frame
                                      type:(WKMediaCaptureType)type
                           decisionHandler:(void (^)(WKPermissionDecision))decision {
  decision(WKPermissionDecisionDeny);
}

- (void)webView:(WKWebView *)webView
    runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
              initiatedByFrame:(WKFrameInfo *)frame
             completionHandler:(void (^)(NSArray<NSURL *> *_Nullable))completion {
  completion(nil);
}

// `window.close()` from the page closes the window, which is a rejection, as the reviewer closing
// it is.
- (void)webViewDidClose:(WKWebView *)webView { [_window close]; }

// MARK: the menu

// Every item this host puts in a menu carries `DGMenuTag`, so a verifier can tell them from the
// ones AppKit adds by itself (AutoFill, Start Dictation, Emoji & Symbols, appended to Edit).
static NSMenuItem *DGItem(NSString *title, SEL action, NSString *key, NSEventModifierFlags mods, id target) {
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key];
  item.keyEquivalentModifierMask = mods;
  item.target = target;
  item.tag = DGMenuTag;
  return item;
}

static void DGAddMenu(NSMenu *bar, NSString *title, NSArray<NSMenuItem *> *items) {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:title];
  for (NSMenuItem *item in items) [menu addItem:item];
  NSMenuItem *holder = [NSMenuItem new];
  holder.submenu = menu;
  [bar addItem:holder];
}

- (void)installMenu {
  NSMenu *bar = [NSMenu new];
  const NSEventModifierFlags cmd = NSEventModifierFlagCommand;
  NSMenuItem *services = DGItem(@"Services", nil, @"", 0, nil);
  services.submenu = [[NSMenu alloc] initWithTitle:@"Services"];
  // The standard macOS app menu.
  DGAddMenu(bar, @"draftgate", @[
    DGItem(@"About draftgate", @selector(orderFrontStandardAboutPanel:), @"", 0, nil),
    NSMenuItem.separatorItem,
    services,
    NSMenuItem.separatorItem,
    DGItem(@"Hide draftgate", @selector(hide:), @"h", cmd, nil),
    DGItem(@"Hide Others", @selector(hideOtherApplications:), @"h", cmd | NSEventModifierFlagOption, nil),
    DGItem(@"Show All", @selector(unhideAllApplications:), @"", 0, nil),
    NSMenuItem.separatorItem,
    DGItem(@"Quit draftgate", @selector(terminate:), @"q", cmd, nil),
  ]);
  NSApp.servicesMenu = services.submenu;
  DGAddMenu(bar, @"Edit", @[
    DGItem(@"Undo", NSSelectorFromString(@"undo:"), @"z", cmd, nil),
    DGItem(@"Redo", NSSelectorFromString(@"redo:"), @"z", cmd | NSEventModifierFlagShift, nil),
    NSMenuItem.separatorItem,
    DGItem(@"Cut", @selector(cut:), @"x", cmd, nil),
    DGItem(@"Copy", @selector(copy:), @"c", cmd, nil),
    DGItem(@"Paste", @selector(paste:), @"v", cmd, nil),
    DGItem(@"Paste and Match Style", @selector(pasteAsPlainText:), @"v",
           cmd | NSEventModifierFlagOption | NSEventModifierFlagShift, nil),
    DGItem(@"Select All", @selector(selectAll:), @"a", cmd, nil),
  ]);
  // Zoom only. No Reload, no DevTools: Reload discards the reviewer's edits, and an inspector on a
  // window whose content an LLM wrote is a capability this window must not offer.
  DGAddMenu(bar, @"View", @[
    DGItem(@"Actual Size", @selector(zoomReset:), @"0", cmd, self),
    DGItem(@"Zoom In", @selector(zoomIn:), @"+", cmd, self),
    DGItem(@"Zoom Out", @selector(zoomOut:), @"-", cmd, self),
  ]);
  DGAddMenu(bar, _destination, @[]);
  NSApp.mainMenu = bar;
}

@end

// MARK: - main

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) DGDie(@"usage: draftgate <surface directory>");
    NSURL *surface = [NSURL fileURLWithPath:@(argv[1]) isDirectory:YES].URLByStandardizingPath;
    NSApplication *app = NSApplication.sharedApplication;
    // Read before any window exists, so a malformed request never shows one.
    static DGHost *host;
    host = [[DGHost alloc] initWithSurface:surface environment:NSProcessInfo.processInfo.environment];
    // A harness run has no Dock icon: its windows are never for a person.
    app.activationPolicy = HARNESS ? NSApplicationActivationPolicyAccessory : NSApplicationActivationPolicyRegular;
    app.delegate = host;
    [app run];
  }
  return 0;
}
