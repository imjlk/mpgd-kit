using Mpgd.MicrosoftStore.Host;

namespace KitStarterHost;

// Exercises the common host on a real WinUI/WebView2 window. These callbacks
// contain no account credentials, SDK checkout or backend grants.
internal sealed class FixtureStoreOperations(string itemId, Func<bool> hasThreadAccess, Action notifyRecoverableFailures) : INativeStoreOperations
{
    internal int Calls { get; private set; }
    internal int PurchaseCalls { get; private set; }
    private void AssertUiThread(CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (!hasThreadAccess()) throw new InvalidOperationException("Fixture callback ran outside its window UI thread.");
    }

    public Task<NativeProductDetailsResult> GetDetailsAsync(GetCatalogDetailsCommand command, CancellationToken cancellation)
    {
        AssertUiThread(cancellation);
        Calls++;
        return Task.FromResult(new NativeProductDetailsResult([new(itemId, "Fixture coins", null, new("USD", "$1.00"))]));
    }

    public async Task<NativePlayerSession> SignInAsync(CancellationToken cancellation)
    {
        AssertUiThread(cancellation);
        Calls++;
        // Complete asynchronously so NativeBridgeHost's ConfigureAwait(false)
        // continuation must enqueue its WebView2 response back onto this UI.
        await Task.Delay(10, cancellation);
        AssertUiThread(cancellation);
        // Simulate SDK notification kinds on the live adapter. Its response
        // must still cross real WebView2; no GPU process is actually terminated.
        notifyRecoverableFailures();
        return new NativePlayerSession(DateTimeOffset.UtcNow.AddMinutes(15).ToUnixTimeMilliseconds(), "ci-fixture-player", new string('f', 64));
    }

    public Task<NativePurchasesResult> ListPurchasesAsync(CancellationToken cancellation)
    {
        AssertUiThread(cancellation);
        Calls++;
        return Task.FromResult(new NativePurchasesResult([new(itemId, itemId)]));
    }

    public Task<NativePurchaseResult> RequestPurchaseAsync(RequestPurchaseCommand command, CancellationToken cancellation)
    {
        AssertUiThread(cancellation);
        Calls++;
        PurchaseCalls++;
        return Task.FromResult(new NativePurchaseResult("succeeded", itemId));
    }
}
