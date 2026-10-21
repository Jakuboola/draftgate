// What `draftgate.m` (the review window) and `harness.m` (its verifier's half) share.
//
// `harness.m` is compiled ONLY into `draftgate-harness.app`, with `-DDG_HARNESS`
// (`cli/src/reviewHost.ts`). `draftgate.app`, the window a review opens, is built from
// `draftgate.m` alone, so it holds no code that evaluates script, synthesises input or takes a
// picture: the review window has no test path to Approve, because the capability is never
// compiled in.
// `surface/harness/host.test.ts` reads the review binary's selector table to hold that.

#import <Cocoa/Cocoa.h>
#import <JavaScriptCore/JavaScriptCore.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN

/// The review's web view. Its context menu is suppressed; see `draftgate.m`.
@interface DGWebView : WKWebView
@end

/// The review's window. A harness window sits off every display, which AppKit would clamp.
@interface DGWindow : NSWindow
@property(nonatomic) BOOL unconstrained;
@end

@interface DGHost : NSObject
@property(nonatomic, readonly) DGWindow *window;
@property(nonatomic, readonly) DGWebView *webView;
/// The zoom LEVEL: the page is drawn at 1.2^level (`geometry.cjs` holds the scale).
@property(nonatomic, readonly) double zoomLevel;
/// Bring the window forward, once: when the page has loaded, or when a harness asks.
- (void)show;
#ifdef DG_HARNESS
/// Load the bundle again, as the probe does once it is attached. Harness only: a review has no
/// reload, because reloading discards the reviewer's edits.
- (WKNavigation *)reloadForHarness;
#endif
@end

/// The `tag` of every menu item the host itself creates. AppKit's own additions carry none.
static const NSInteger DGMenuTag = 0x6467;

#ifdef DG_HARNESS
/// The console capture and the channel's message handler, on the configuration before the view.
void DGHarnessConfigure(WKWebViewConfiguration *config);
/// Place the window off every screen at 1% opacity, before the host watches where it moves.
void DGHarnessPlace(DGWindow *window);
/// Does the verifier bring this window forward itself (the `show` op), rather than the load?
BOOL DGHarnessShowsWhenAsked(void);
/// Open the control channel.
void DGHarnessStart(DGHost *host);
/// A load the host started has finished.
void DGHarnessLoaded(WKNavigation *navigation);
/// The harness's own placement file, inside its channel directory: never the reviewer's.
NSString *_Nullable DGHarnessWindowStatePath(void);
/// WebKit is about to show a context menu. The review build never gets here; see `draftgate.m`.
void DGHarnessMenuWillOpen(NSMenu *menu);
#endif

NS_ASSUME_NONNULL_END
