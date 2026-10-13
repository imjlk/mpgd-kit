using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;

namespace Mpgd.MicrosoftStore.Host;

/// <summary>Attach after EnsureCoreWebView2Async, before the first navigation.
/// Dispose on Window.Closed. Host objects and devtools are disabled.</summary>
public sealed class WebView2NativeBridge : IDisposable
{
    private readonly WebView2 view;
    private readonly CoreWebView2 core;
    private readonly NativeBridgeOrigin origin;
    private readonly NativeBridgeHost host;
    private readonly Action<Exception>? onTransportError;
    private ulong navigationId;
    private bool documentActivated;
    private bool documentRejected;
    private bool closed;

    public WebView2NativeBridge(WebView2 view, Uri startUri, IEnumerable<string> allowedItemIds,
        INativeStoreOperations operations, Action<Exception>? onTransportError = null)
    {
        ArgumentNullException.ThrowIfNull(view);
        if (!view.DispatcherQueue.HasThreadAccess)
            throw new InvalidOperationException("Attach the bridge on the window's UI thread.");
        this.view = view;
        core = view.CoreWebView2 ?? throw new InvalidOperationException("Initialize WebView2 before attaching the bridge.");
        origin = new(startUri);
        this.onTransportError = onTransportError;
        host = new(origin, allowedItemIds, operations, new DispatcherQueueBridgeDispatcher(view.DispatcherQueue),
            response => core.PostWebMessageAsJson(response));
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.NavigationStarting += NavigationStarting;
        core.ContentLoading += ContentLoading;
        core.NavigationCompleted += NavigationCompleted;
        core.NewWindowRequested += NewWindowRequested;
        core.WebMessageReceived += WebMessageReceived;
        core.ProcessFailed += ProcessFailed;
    }

    private void NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs args)
    {
        navigationId = args.NavigationId;
        documentActivated = false;
        documentRejected = false;
        host.InvalidateDocument();
        if (!origin.Allows(args.Uri)) args.Cancel = true;
    }

    private void ContentLoading(object? sender, CoreWebView2ContentLoadingEventArgs args)
    {
        if (closed || args.NavigationId != navigationId) return;
        documentRejected = args.IsErrorPage;
        // The new document is committed before its startup scripts can send
        // messages. Waiting for NavigationCompleted drops valid boot requests.
        if (!documentRejected) documentActivated = host.ActivateDocument(core.Source);
    }

    private void NavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs args)
    {
        if (closed || args.NavigationId != navigationId) return;
        if (!args.IsSuccess)
        {
            documentActivated = false;
            host.InvalidateDocument();
        }
        else if (!documentActivated && !documentRejected)
            documentActivated = host.ActivateDocument(core.Source);
    }

    private static void NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs args) => args.Handled = true;

    private void ProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs args)
    {
        documentActivated = false;
        host.InvalidateDocument();
    }

    private async void WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (closed) return;
        try { await host.HandleMessageAsync(args.Source, args.WebMessageAsJson); }
        catch (Exception error) { onTransportError?.Invoke(error); }
    }

    public void Dispose()
    {
        if (!view.DispatcherQueue.HasThreadAccess)
            throw new InvalidOperationException("Detach the bridge on the window's UI thread.");
        if (closed) return;
        closed = true;
        host.Dispose();
        core.NavigationStarting -= NavigationStarting;
        core.ContentLoading -= ContentLoading;
        core.NavigationCompleted -= NavigationCompleted;
        core.NewWindowRequested -= NewWindowRequested;
        core.WebMessageReceived -= WebMessageReceived;
        core.ProcessFailed -= ProcessFailed;
    }
}
