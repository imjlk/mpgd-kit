using System.Text.Json;

namespace Mpgd.MicrosoftStore.Host;

// The public v1 request stays unchanged inside a document-scoped envelope.
internal static class WebView2DocumentTransport
{
    internal const string Protocol = "mpgd.microsoft-store.document.v1";
    internal const string ReadNonceScript = "globalThis.__mpgdMicrosoftStoreDocumentNonce ?? null";
    internal const string Bootstrap = """
        (() => {
            const view = globalThis.chrome?.webview;
            if (!view) return;
            const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)),
                byte => byte.toString(16).padStart(2, '0')).join('');
            const post = view.postMessage.bind(view);
            Object.defineProperty(globalThis, '__mpgdMicrosoftStoreDocumentNonce', { value: nonce });
            Object.defineProperty(view, 'postMessage', {
                writable: false, configurable: false,
                value: message => post(message?.protocol === 'mpgd.microsoft-store.native.v1'
                    ? { transport: 'mpgd.microsoft-store.document.v1', documentNonce: nonce, request: message }
                    : message),
            });
        })();
        """;

    internal static bool TryReadRequest(string json, out string nonce, out string request)
    {
        nonce = request = "";
        if (string.IsNullOrEmpty(json) || json.Length > NativeBridgeProtocol.MaximumMessageLength + 512) return false;
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 10 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 3
                || !root.TryGetProperty("transport", out var transport) || transport.ValueKind != JsonValueKind.String || transport.GetString() != Protocol
                || !root.TryGetProperty("documentNonce", out var token) || token.ValueKind != JsonValueKind.String
                || !Guid.TryParseExact(token.GetString(), "N", out _)
                || !root.TryGetProperty("request", out var payload) || payload.ValueKind != JsonValueKind.Object) return false;
            nonce = token.GetString()!;
            request = payload.GetRawText();
            return request.Length <= NativeBridgeProtocol.MaximumMessageLength;
        }
        catch (JsonException) { return false; }
    }
}
