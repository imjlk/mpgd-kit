using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mpgd.MicrosoftStore.Host;

internal static class NativeBridgeResult
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    internal static string Success(BridgeCommand command, object result, IReadOnlySet<string> allowed)
    {
        bool valid = (command, result) switch
        {
            (GetCatalogDetailsCommand request, NativeProductDetailsResult details) =>
                details.Items is not null && details.Items.Count <= request.ItemIds.Count
                && details.Items.Select(item => item?.ItemId).Distinct(StringComparer.Ordinal).Count() == details.Items.Count
                && details.Items.All(item => item is not null && allowed.Contains(item.ItemId) && request.ItemIds.Contains(item.ItemId)
                    && Text(item.Title, 512) && (item.Description is null || Text(item.Description, 4096, allowDescriptionWhitespace: true))
                    && item.Price is not null && Text(item.Price.Formatted, 128)
                    && item.Price.CurrencyCode is { Length: 3 } currency && currency.All(c => c is >= 'A' and <= 'Z')),
            (SignInCommand, NativePlayerSession session) =>
                session.ExpiresAt >= DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds()
                && session.ExpiresAt <= DateTimeOffset.UtcNow.AddHours(24).ToUnixTimeMilliseconds()
                && NativeBridgeProtocol.IsValidIdentifier(session.PlayerId, 256) && Token(session.SessionToken),
            (ListPurchasesCommand, NativePurchasesResult purchases) =>
                purchases.Items is not null && purchases.Items.Count <= NativeBridgeProtocol.MaximumItemCount
                && purchases.Items.Select(item => item?.ItemId).Distinct(StringComparer.Ordinal).Count() == purchases.Items.Count
                && purchases.Items.All(item => item is not null && allowed.Contains(item.ItemId) && item.PurchaseToken == item.ItemId),
            (RequestPurchaseCommand request, NativePurchaseResult purchase) =>
                purchase.Status is "succeeded" or "already-purchased"
                    ? purchase.PurchaseToken == request.ItemId
                    : purchase.Status is "not-purchased" or "network-error" or "server-error" && purchase.PurchaseToken is null,
            _ => false,
        };
        if (!valid) throw new InvalidOperationException("Invalid native result.");
        string response = JsonSerializer.Serialize(new { protocol = NativeBridgeProtocol.Protocol, command.RequestId, command.Method, ok = true, result }, Options);
        if (response.Length > NativeBridgeProtocol.MaximumMessageLength) throw new InvalidOperationException("Native response exceeds message limit.");
        return response;
    }

    internal static string Failure(string requestId, string method, string errorCode) =>
        JsonSerializer.Serialize(new { protocol = NativeBridgeProtocol.Protocol, requestId, method, ok = false, errorCode }, Options);

    private static bool Text(string? text, int maximum, bool allowDescriptionWhitespace = false)
    {
        if (string.IsNullOrWhiteSpace(text) || text.Length > maximum) return false;
        string inspected = allowDescriptionWhitespace ? text.Replace("\t", "").Replace("\n", "").Replace("\r", "") : text;
        return NativeBridgeProtocol.IsValidIdentifier(inspected.Trim(), maximum);
    }

    private static bool Token(string? token, int minimum = 32) => NativeBridgeProtocol.IsValidIdentifier(token, 4096)
        && token!.Length >= minimum && !token.Any(char.IsWhiteSpace);
}
