namespace Mpgd.MicrosoftStore.Host;

// Only these web-facing results are serialized. SDK credentials and backend
// collections tickets stay inside the game-owned implementation.
public sealed record NativeProductPrice(string CurrencyCode, string Formatted);
public sealed record NativeProductDetail(string ItemId, string Title, string? Description, NativeProductPrice Price);
public sealed record NativeProductDetailsResult(IReadOnlyList<NativeProductDetail> Items);
public sealed record NativePlayerSession(long ExpiresAt, string PlayerId, string SessionToken);
public sealed record NativePurchase(string ItemId, string PurchaseToken);
public sealed record NativePurchasesResult(IReadOnlyList<NativePurchase> Items);
public sealed record NativePurchaseResult(string Status, string? PurchaseToken = null);

public interface INativeStoreOperations
{
    Task<NativeProductDetailsResult> GetDetailsAsync(GetCatalogDetailsCommand command, CancellationToken cancellation);
    Task<NativePlayerSession> SignInAsync(CancellationToken cancellation);
    Task<NativePurchasesResult> ListPurchasesAsync(CancellationToken cancellation);
    Task<NativePurchaseResult> RequestPurchaseAsync(RequestPurchaseCommand command, CancellationToken cancellation);
}

/// <summary>Run the callback on the owning window's UI thread. Cancellation must
/// prevent callbacks that are still queued from starting.</summary>
public interface INativeBridgeDispatcher
{
    Task RunAsync(Func<Task> callback, CancellationToken cancellation);
}

public enum NativeBridgeFailure { UserCancelled, IdentityUnavailable, StoreUnavailable }

public sealed class NativeBridgeOperationException(NativeBridgeFailure failure) : Exception
{
    public NativeBridgeFailure Failure { get; } = failure;
}
