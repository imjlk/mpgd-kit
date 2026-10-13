using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.Web.WebView2.Core;
using Windows.Storage;

namespace KitStarterHost;

// This host belongs only to KIT CI. It has no Store commerce or account bridge.
public sealed partial class MainWindow : Window
{
    private readonly DispatcherTimer probe = new() { Interval = TimeSpan.FromSeconds(1) };
    private bool probing;
    private string bundleSha256 = "";

    public MainWindow()
    {
        InitializeComponent();
        Title = "MPGD KIT generated starter acceptance";
        probe.Tick += ProbeStarter;
        Closed += (_, _) => probe.Stop();
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
            core.NavigationStarting += (_, navigation) =>
            {
                if (!Uri.TryCreate(navigation.Uri, UriKind.Absolute, out var uri) ||
                    uri.Scheme != "https" || uri.Host != "starter.mpgd.invalid")
                {
                    navigation.Cancel = true;
                    RecordFailure(new InvalidOperationException("Unexpected starter navigation."));
                }
            };
            core.NavigationCompleted += (_, navigation) =>
            {
                if (!navigation.IsSuccess)
                    RecordFailure(new InvalidOperationException("Starter navigation failed: " + navigation.WebErrorStatus));
            };
            core.ProcessFailed += (_, failure) => RecordFailure(
                new InvalidOperationException("WebView2 process failed: " + failure.ProcessFailedKind));
            await core.AddScriptToExecuteOnDocumentCreatedAsync("""
                globalThis.__mpgdNativeErrors = [];
                addEventListener('error', e => __mpgdNativeErrors.push(String(e.message || 'resource error')), true);
                addEventListener('unhandledrejection', e => __mpgdNativeErrors.push(String(e.reason)));
                """);
            core.Navigate("https://starter.mpgd.invalid/index.html");
            probe.Start();
        }
        catch (Exception error) { RecordFailure(error); }
    }

    private async void ProbeStarter(object? sender, object args)
    {
        if (probing) return;
        probing = true;
        try
        {
            var result = await GameWebView.CoreWebView2.ExecuteScriptAsync("""
                (() => {
                    const c = document.querySelector('#game canvas');
                    return {
                        url: location.href, canvasWidth: c?.width ?? 0, canvasHeight: c?.height ?? 0,
                        gameBundleLoaded: performance.getEntriesByType('resource').some(
                            e => new URL(e.name).pathname === '/assets/game.js'),
                        bootError: document.querySelector('.boot-error') !== null,
                        errors: globalThis.__mpgdNativeErrors ?? ['probe not initialized']
                    };
                })()
                """);
            var state = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(result)
                ?? throw new InvalidOperationException("Missing starter probe result.");
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
