namespace Mpgd.MicrosoftStore.Host;

public abstract record BridgeCommand(string RequestId, string Method);

public sealed record GetCatalogDetailsCommand(
    string RequestId,
    IReadOnlyList<string> ItemIds)
    : BridgeCommand(RequestId, NativeBridgeProtocol.CatalogGetDetailsMethod);

public sealed record SignInCommand(string RequestId)
    : BridgeCommand(RequestId, NativeBridgeProtocol.IdentitySignInMethod);

public sealed record ListPurchasesCommand(string RequestId)
    : BridgeCommand(RequestId, NativeBridgeProtocol.PurchaseListMethod);

public sealed record RequestPurchaseCommand(string RequestId, string ItemId)
    : BridgeCommand(RequestId, NativeBridgeProtocol.PurchaseRequestMethod);
