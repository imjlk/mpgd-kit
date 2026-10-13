using Mpgd.MicrosoftStore.Host;

namespace KitStarterHost;

// Exercises the common host on a real WinUI/WebView2 window. These callbacks
// contain no account credentials, SDK checkout or backend grants.
internal sealed class FixtureStoreOperations(string itemId) : INativeStoreOperations
{
    public Task<NativeProductDetailsResult> GetDetailsAsync(GetCatalogDetailsCommand command, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        return Task.FromResult(new NativeProductDetailsResult([new(itemId, "Fixture coins", null, new("USD", "$1.00"))]));
    }

    public Task<NativePlayerSession> SignInAsync(CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        return Task.FromResult(new NativePlayerSession(DateTimeOffset.UtcNow.AddMinutes(15).ToUnixTimeMilliseconds(), "ci-fixture-player", new string('f', 64)));
    }

    public Task<NativePurchasesResult> ListPurchasesAsync(CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        return Task.FromResult(new NativePurchasesResult([new(itemId, itemId)]));
    }

    public Task<NativePurchaseResult> RequestPurchaseAsync(RequestPurchaseCommand command, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        return Task.FromResult(new NativePurchaseResult("succeeded", itemId));
    }
}
