# Microsoft Store native host support

These C# sources ship inside the existing `@mpgd/cli` npm package. No additional
npm or NuGet package is required. The core targets .NET 8 without SDK or NuGet
dependencies. The optional WinUI files compile inside your existing Windows
App SDK / WebView2 host.

```js
import { getMicrosoftStoreNativeHostSourceDirectory } from '@mpgd/cli/windows-native-tools';
const sources = getMicrosoftStoreNativeHostSourceDirectory();
```

The locator returns the installed `dist/windows-host` directory. SDK-dependent
sources are maintained in `native-plugins/microsoft-store-host/windows` and copied
there during the CLI build. SDK-independent sources stay in the CLI source tree.

Copy the source tree into a game-owned, ignored build directory. Reference
`Core/Mpgd.MicrosoftStore.Host.csproj` or link `Core/*.cs` directly; link
`WinUI/*.cs` only into a Windows host. Keep `bin` and `obj` outside the installed
npm package. CI builds and exercises these files after packing and installing
the CLI, without relying on a workspace project reference.

## Attach to a window

On the window's UI thread, initialize WebView2, then attach before navigating:

```csharp
await webView.EnsureCoreWebView2Async();
StoreContext store = WindowStoreContext.Create(window);
var bridge = new WebView2NativeBridge(
    webView, new Uri(gameConfiguration.StartUri),
    gameConfiguration.AllowedItemIds, gameOwnedOperations);
window.Closed += (_, _) => bridge.Dispose();
webView.CoreWebView2.Navigate(gameConfiguration.StartUri);
```

The adapter checks HTTPS host and port, rejects credentials in navigation URLs,
blocks new windows, disables host objects and devtools, and accepts messages
from a committed, allowed document as it starts loading, including startup
requests before the load-complete event. Failed navigation and every navigation
start or WebView2
process failure invalidates the document. Queued operations are cancelled and
late replies from the previous document are suppressed, including navigation
back to the same URL. Closure detaches handlers and suppresses responses. Use
one adapter and operation implementation per window.

`WindowStoreContext.Create` initializes the SDK with that window's HWND on its
UI thread. Keep the context in native code. Initialization does not perform
login, checkout or grant an entitlement.

## Game-owned operations

Implement `INativeStoreOperations` with typed callbacks for catalog, sign-in,
purchase listing and checkout. Callbacks begin on the window UI thread and are
serialized. Observe cancellation whenever the SDK permits it. An SDK operation
that ignores cancellation retains its serialization lease until it finishes;
its result is still suppressed after navigation or closure.

The common code parses `mpgd.microsoft-store.native.v1`, enforces message limits,
allowed products, duplicate IDs and pending-request limits, and serializes only
the declared bounded result records. Invalid results and unexpected exceptions
become `NATIVE_OPERATION_FAILED`; exception messages never reach the web page.
Use `NativeBridgeOperationException` for declared user-cancelled,
identity-unavailable or store-unavailable errors.

The game owns Store IDs and offers, MSAL/WAM account selection, backend endpoints,
SDK product validation and session issuance. Sign-in returns the game backend's
short-lived player session, never an SDK access token. Collections IDs, Microsoft
service tickets and account credentials stay in private native/backend state.
Client checkout produces evidence; the backend ledger verifies and commits all
durable grants.

`NativePlayerSession.ExpiresAt` uses Unix epoch milliseconds, with 1 minute to
24 hours remaining at serialization. It accepts a bounded player ID
and a whitespace-free token of 32–4096 characters. Games may enforce a shorter
lifetime. Product and purchase results must refer to their allowlist. Purchase
tokens equal their item ID, matching the existing web client contract; the
authoritative backend still verifies and commits the purchase.

## Core-only integration

For a custom transport, construct `NativeBridgeHost` with an
`INativeBridgeDispatcher`. Run queued callbacks on the owning UI thread, prevent
cancelled queued callbacks from starting, and await started operations until
they finish. `postResponse` synchronously sends JSON on that thread. Call
`InvalidateDocument` at every navigation start, `ActivateDocument` only after an
allowed document commits, invalidate again on load failure, and `Dispose` at
closure. Lifecycle calls
and response delivery must share the window UI dispatcher.

## Acceptance scope

Contract tests cover two independent game configurations, protocol and product
rejection, sanitized errors, duplicate/busy requests, cancelled queues, navigation
generation and closure. Windows CI links the installed package's core and WinUI
sources into x64/ARM64 MSIX, binds StoreContext to the native window, and exercises
four methods through WebView2 with fixture callbacks. Receipts identify fixture
results separately. They do not claim real Store login, settled purchases,
backend grants or Store upload.
