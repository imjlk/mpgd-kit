using System.Globalization;
using System.Text.Json;

namespace Mpgd.MicrosoftStore.Host;

public static class NativeBridgeProtocol
{
    public const string Protocol = "mpgd.microsoft-store.native.v1";
    public const string CatalogGetDetailsMethod = "catalog.getDetails";
    public const string IdentitySignInMethod = "identity.signIn";
    public const string PurchaseListMethod = "purchase.list";
    public const string PurchaseRequestMethod = "purchase.request";

    public const string InvalidRequestError = "INVALID_REQUEST";
    public const string BridgeBusyError = "BRIDGE_BUSY";
    public const string DuplicateRequestError = "DUPLICATE_REQUEST";
    public const string ProductNotAllowedError = "PRODUCT_NOT_ALLOWED";
    public const string UnsupportedMethodError = "UNSUPPORTED_METHOD";

    public const int MaximumMessageLength = 64 * 1024;
    public const int MaximumItemCount = 64;
    public const int MaximumItemIdLength = 256;
    public const int MaximumMethodNameLength = 64;
    public const int MaximumRequestIdLength = 128;

    private static readonly JsonDocumentOptions DocumentOptions = new()
    {
        AllowTrailingCommas = false,
        CommentHandling = JsonCommentHandling.Disallow,
        MaxDepth = 8,
    };

    private static readonly HashSet<string> RequestProperties =
        ["protocol", "requestId", "method", "payload"];
    private static readonly HashSet<string> EmptyProperties = [];
    private static readonly HashSet<string> CatalogPayloadProperties = ["itemIds"];
    private static readonly HashSet<string> PurchasePayloadProperties = ["itemId"];

    public static bool TryParseCommand(
        string message,
        IReadOnlySet<string> allowedItemIds,
        out BridgeCommand? command,
        out string errorCode)
    {
        command = null;
        errorCode = InvalidRequestError;
        if (string.IsNullOrEmpty(message) || message.Length > MaximumMessageLength)
        {
            return false;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(message, DocumentOptions);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !HasExactProperties(root, RequestProperties))
            {
                return false;
            }

            if (!TryReadExactString(root, "protocol", Protocol.Length, out string protocol)
                || protocol != Protocol
                || !TryReadIdentifier(
                    root,
                    "requestId",
                    MaximumRequestIdLength,
                    out string requestId)
                || !TryReadIdentifier(
                    root,
                    "method",
                    MaximumMethodNameLength,
                    out string method)
                || !root.TryGetProperty("payload", out JsonElement payload)
                || payload.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            switch (method)
            {
                case CatalogGetDetailsMethod:
                    return TryParseCatalogCommand(
                        requestId,
                        payload,
                        allowedItemIds,
                        out command,
                        out errorCode);
                case IdentitySignInMethod:
                    if (!HasExactProperties(payload, EmptyProperties))
                    {
                        return false;
                    }

                    command = new SignInCommand(requestId);
                    return true;
                case PurchaseListMethod:
                    if (!HasExactProperties(payload, EmptyProperties))
                    {
                        return false;
                    }

                    command = new ListPurchasesCommand(requestId);
                    return true;
                case PurchaseRequestMethod:
                    return TryParsePurchaseCommand(
                        requestId,
                        payload,
                        allowedItemIds,
                        out command,
                        out errorCode);
                default:
                    errorCode = UnsupportedMethodError;
                    return false;
            }
        }
        catch (JsonException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    public static bool TryReadRouting(
        string message,
        out string requestId,
        out string method)
    {
        requestId = string.Empty;
        method = string.Empty;
        if (string.IsNullOrEmpty(message) || message.Length > MaximumMessageLength)
        {
            return false;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(message, DocumentOptions);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !TryReadExactString(root, "protocol", Protocol.Length, out string protocol)
                || protocol != Protocol
                || !TryReadIdentifier(
                    root,
                    "requestId",
                    MaximumRequestIdLength,
                    out requestId)
                || !TryReadIdentifier(
                    root,
                    "method",
                    MaximumMethodNameLength,
                    out method))
            {
                requestId = string.Empty;
                method = string.Empty;
                return false;
            }

            return true;
        }
        catch (JsonException)
        {
            requestId = string.Empty;
            method = string.Empty;
            return false;
        }
        catch (InvalidOperationException)
        {
            requestId = string.Empty;
            method = string.Empty;
            return false;
        }
    }

    private static bool TryParseCatalogCommand(
        string requestId,
        JsonElement payload,
        IReadOnlySet<string> allowedItemIds,
        out BridgeCommand? command,
        out string errorCode)
    {
        command = null;
        errorCode = InvalidRequestError;
        if (!HasExactProperties(payload, CatalogPayloadProperties)
            || !payload.TryGetProperty("itemIds", out JsonElement itemIds)
            || itemIds.ValueKind != JsonValueKind.Array
            || itemIds.GetArrayLength() is < 1 or > MaximumItemCount)
        {
            return false;
        }

        List<string> normalized = new(itemIds.GetArrayLength());
        HashSet<string> unique = new(StringComparer.Ordinal);
        foreach (JsonElement itemIdValue in itemIds.EnumerateArray())
        {
            if (!TryReadIdentifier(itemIdValue, MaximumItemIdLength, out string itemId)
                || !unique.Add(itemId))
            {
                return false;
            }

            if (!allowedItemIds.Contains(itemId))
            {
                errorCode = ProductNotAllowedError;
                return false;
            }

            normalized.Add(itemId);
        }

        command = new GetCatalogDetailsCommand(requestId, normalized.AsReadOnly());
        return true;
    }

    private static bool TryParsePurchaseCommand(
        string requestId,
        JsonElement payload,
        IReadOnlySet<string> allowedItemIds,
        out BridgeCommand? command,
        out string errorCode)
    {
        command = null;
        errorCode = InvalidRequestError;
        if (!HasExactProperties(payload, PurchasePayloadProperties)
            || !TryReadIdentifier(
                payload,
                "itemId",
                MaximumItemIdLength,
                out string itemId))
        {
            return false;
        }

        if (!allowedItemIds.Contains(itemId))
        {
            errorCode = ProductNotAllowedError;
            return false;
        }

        command = new RequestPurchaseCommand(requestId, itemId);
        return true;
    }

    private static bool HasExactProperties(JsonElement value, IReadOnlySet<string> expected)
    {
        HashSet<string> seen = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!expected.Contains(property.Name) || !seen.Add(property.Name))
            {
                return false;
            }
        }

        return seen.Count == expected.Count;
    }

    private static bool TryReadExactString(
        JsonElement owner,
        string propertyName,
        int expectedLength,
        out string value)
    {
        value = string.Empty;
        if (!owner.TryGetProperty(propertyName, out JsonElement candidate)
            || candidate.ValueKind != JsonValueKind.String
            || candidate.GetString() is not string text
            || text.Length != expectedLength)
        {
            return false;
        }

        value = text;
        return true;
    }

    private static bool TryReadIdentifier(
        JsonElement owner,
        string propertyName,
        int maximumLength,
        out string value)
    {
        value = string.Empty;
        return owner.TryGetProperty(propertyName, out JsonElement candidate)
            && TryReadIdentifier(candidate, maximumLength, out value);
    }

    private static bool TryReadIdentifier(
        JsonElement candidate,
        int maximumLength,
        out string value)
    {
        value = string.Empty;
        if (candidate.ValueKind != JsonValueKind.String
            || candidate.GetString() is not string text
            || !IsValidIdentifier(text, maximumLength))
        {
            return false;
        }

        value = text;
        return true;
    }

    internal static bool IsValidIdentifier(string? text, int maximumLength) => text is not null
        && text.Length is >= 1 && text.Length <= maximumLength && text == text.Trim()
        && !ContainsForbiddenIdentifierCharacter(text);

    private static bool ContainsForbiddenIdentifierCharacter(string value)
    {
        for (int index = 0; index < value.Length; index += 1)
        {
            char character = value[index];
            if (char.IsSurrogate(character) && !char.IsSurrogatePair(value, index))
            {
                return true;
            }

            UnicodeCategory category = CharUnicodeInfo.GetUnicodeCategory(value, index);
            if (category is UnicodeCategory.Control or UnicodeCategory.Format)
            {
                return true;
            }

            if (char.IsHighSurrogate(character))
            {
                index += 1;
            }
        }

        return false;
    }
}
