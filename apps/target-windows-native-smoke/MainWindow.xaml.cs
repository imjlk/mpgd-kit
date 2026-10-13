using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.Web.WebView2.Core;
using Windows.Storage;
using Mpgd.MicrosoftStore.Host;

namespace KitStarterHost;

// CI exercises typed fixture callbacks; real Store login and checkout remain
// game-owned and are not claimed by this acceptance host.
public sealed partial class MainWindow : Window
{
    private readonly DispatcherTimer probe = new() { Interval = TimeSpan.FromSeconds(1) };
    private bool probing;
    private string bundleSha256 = "";
    private WebView2NativeBridge? bridge;
    private FixtureStoreOperations? fixtureOperations;
    private string? previousDocumentNonce;
    private bool staleDocumentMessageRejected;
    private int bridgeScenario;
    private readonly List<JsonElement> bridgeEvidence = [];
    private bool closed;

    public MainWindow()
    {
        InitializeComponent();
        Title = "MPGD KIT generated starter acceptance";
        probe.Tick += ProbeStarter;
        Closed += (_, _) => { closed = true; probe.Stop(); bridge?.Dispose(); };
    }

    internal static void RecordFailure(Exception error) => File.WriteAllText(
        Path.Combine(ApplicationData.Current.LocalFolder.Path, "host-error.log"), error.ToString());

    private async void OnWebViewLoaded(object sender, RoutedEventArgs args)
    {
        try
        {
            var root = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            bundleSha256 = Convert.ToHexString(SHA256.HashData(
                File.ReadAllBytes(Path.Combine(root, "assets", "game.js")))).ToLowerInvariant();
            // Hosted CI VMs need an explicit software WebGL renderer.
            Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--enable-unsafe-swiftshader");
            await GameWebView.EnsureCoreWebView2Async();
            var core = GameWebView.CoreWebView2;
            core.SetVirtualHostNameToFolderMapping("starter.mpgd.invalid", root, CoreWebView2HostResourceAccessKind.Deny);
            // Validate HWND binding on the owning UI thread without performing
            // Store commerce. The context is private to this native host.
            _ = WindowStoreContext.Create(this);
            await AttachFixtureBridge();
            core.AddWebResourceRequestedFilter("https://ci-load-gate.mpgd.invalid/gate.svg", CoreWebView2WebResourceContext.Image);
            core.WebResourceRequested += async (_, request) =>
            {
                var deferral = request.GetDeferral();
                try
                {
                    // Keep load completion pending while the real web client
                    // sends its startup requests from the committed document.
                    await Task.Delay(2000);
                    if (!closed)
                    {
                        var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
                        using var writer = new Windows.Storage.Streams.DataWriter(stream);
                        writer.WriteString("<svg xmlns='http://www.w3.org/2000/svg'/>");
                        await writer.StoreAsync();
                        writer.DetachStream();
                        stream.Seek(0);
                        request.Response = core.Environment.CreateWebResourceResponse(
                            stream, 200, "OK", "Content-Type: image/svg+xml");
                    }
                }
                catch (Exception error) { RecordFailure(error); }
                finally { deferral.Complete(); }
            };
            core.ContentLoading += (_, loading) =>
            {
                if (!loading.IsErrorPage)
                {
                    DispatcherQueue.TryEnqueue(async () =>
                    {
                        if (closed) return;
                        try { await StartBridgeProbe(); }
                        catch (Exception error) { RecordFailure(error); }
                    });
                }
            };
            core.NavigationCompleted += (_, navigation) =>
            {
                if (!navigation.IsSuccess && navigation.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
                    RecordFailure(new InvalidOperationException("Starter navigation failed: " + navigation.WebErrorStatus));
            };
            core.ProcessFailed += (_, failure) => RecordFailure(
                new InvalidOperationException("WebView2 process failed: " + failure.ProcessFailedKind));
            await core.AddScriptToExecuteOnDocumentCreatedAsync("""
                globalThis.__mpgdNativeErrors = [];
                addEventListener('error', e => __mpgdNativeErrors.push(String(e.message || 'resource error')), true);
                addEventListener('unhandledrejection', e => __mpgdNativeErrors.push(String(e.reason)));
                addEventListener('DOMContentLoaded', () => {
                    const gate = document.createElement('img');
                    gate.src = 'https://ci-load-gate.mpgd.invalid/gate.svg';
                    document.body.append(gate);
                });
                """);
            core.Navigate("https://starter.mpgd.invalid/index.html");
            probe.Start();
        }
        catch (Exception error) { RecordFailure(error); }
    }

    private async Task AttachFixtureBridge()
    {
        bridge?.Dispose();
        string item = bridgeScenario == 0 ? "puzzle.coins" : "tower.coins";
        fixtureOperations = new(item, () => DispatcherQueue.HasThreadAccess, () =>
            {
                foreach (var kind in new[] { CoreWebView2ProcessFailedKind.GpuProcessExited,
                    CoreWebView2ProcessFailedKind.UtilityProcessExited, CoreWebView2ProcessFailedKind.SandboxHelperProcessExited,
                    CoreWebView2ProcessFailedKind.FrameRenderProcessExited, CoreWebView2ProcessFailedKind.RenderProcessUnresponsive })
                    bridge!.HandleProcessFailure(kind);
            });
        bridge = await WebView2NativeBridge.AttachAsync(GameWebView,
            new Uri("https://starter.mpgd.invalid/index.html"), [item], fixtureOperations, RecordFailure);
    }

    private async Task<string> StartBridgeProbe()
    {
        if (bridgeScenario == 1 && !staleDocumentMessageRejected)
        {
            if (previousDocumentNonce is null) throw new InvalidOperationException("Missing previous document nonce.");
            var stale = JsonSerializer.Serialize(new {
                transport = WebView2DocumentTransport.Protocol, documentNonce = previousDocumentNonce,
                request = new { protocol = NativeBridgeProtocol.Protocol, requestId = "stale-document",
                    method = NativeBridgeProtocol.PurchaseRequestMethod, payload = new { itemId = "tower.coins" } }
            });
            int before = fixtureOperations!.PurchaseCalls;
            await bridge!.HandleTransportMessageAsync("https://starter.mpgd.invalid/index.html", stale);
            if (fixtureOperations.PurchaseCalls != before) throw new InvalidOperationException("Old document started a checkout.");
            staleDocumentMessageRejected = true;
        }
        string item = JsonSerializer.Serialize(bridgeScenario == 0 ? "puzzle.coins" : "tower.coins");
        return await GameWebView.CoreWebView2.ExecuteScriptAsync("""
            globalThis.__mpgdBridgeProbe = { complete: false, passed: false };
            import('/native-bridge-fixture.js')
                .then(module => module.startBridgeProbe(ITEM_ID))
                .catch(() => { globalThis.__mpgdBridgeProbe.complete = true; });
            """.Replace("ITEM_ID", item));
    }
    private async void ProbeStarter(object? sender, object args)
    {
        if (probing) return;
        probing = true;
        try
        {
            if (closed) return;
            var result = await GameWebView.CoreWebView2.ExecuteScriptAsync("""
                (() => {
                    const c = document.querySelector('#game canvas');
                    return {
                        url: location.href, canvasWidth: c?.width ?? 0, canvasHeight: c?.height ?? 0,
                        gameBundleLoaded: performance.getEntriesByType('resource').some(
                            e => new URL(e.name).pathname === '/assets/game.js'),
                        bootError: document.querySelector('.boot-error') !== null,
                        errors: globalThis.__mpgdNativeErrors ?? ['probe not initialized'],
                        nativeBridge: globalThis.__mpgdBridgeProbe ?? { complete: false }
                    };
                })()
                """);
            var state = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(result)
                ?? throw new InvalidOperationException("Missing starter probe result.");
            if (closed) return;
            string expectedItem = bridgeScenario == 0 ? "puzzle.coins" : "tower.coins";
            if (bridgeEvidence.Count < 2 && state["nativeBridge"].GetProperty("complete").GetBoolean()
                && state["nativeBridge"].TryGetProperty("itemId", out var itemId) && itemId.GetString() == expectedItem)
            {
                var evidence = state["nativeBridge"];
                if (!evidence.GetProperty("passed").GetBoolean() || !evidence.GetProperty("beforeDocumentLoad").GetBoolean())
                    throw new InvalidOperationException("Native fixture bridge contract failed: " + evidence.GetRawText());
                bridgeEvidence.Add(evidence.Clone());
                if (bridgeScenario == 0)
                {
                    previousDocumentNonce = JsonSerializer.Deserialize<string>(await GameWebView.CoreWebView2.ExecuteScriptAsync(WebView2DocumentTransport.ReadNonceScript));
                    bridgeScenario = 1;
                    await AttachFixtureBridge();
                    GameWebView.CoreWebView2.Navigate("https://starter.mpgd.invalid/index.html");
                    return;
                }
            }
            state["nativeHostContracts"] = JsonSerializer.SerializeToElement(bridgeEvidence);
            state["staleDocumentMessageRejected"] = JsonSerializer.SerializeToElement(staleDocumentMessageRejected);
            state["bundleSha256"] = JsonSerializer.SerializeToElement(bundleSha256);
            state["observedAt"] = JsonSerializer.SerializeToElement(DateTime.UtcNow.ToString("o"));
            var path = Path.Combine(ApplicationData.Current.LocalFolder.Path, "starter-ready.json");
            File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(state));
            File.Move(path + ".tmp", path, true);
        }
        catch (Exception error) { RecordFailure(error); }
        finally { probing = false; }
    }
}
