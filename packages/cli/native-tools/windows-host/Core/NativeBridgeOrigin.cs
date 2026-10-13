namespace Mpgd.MicrosoftStore.Host;

public sealed class NativeBridgeOrigin
{
    private readonly Uri origin;

    public NativeBridgeOrigin(Uri startUri)
    {
        ArgumentNullException.ThrowIfNull(startUri);
        if (!startUri.IsAbsoluteUri || startUri.Scheme != Uri.UriSchemeHttps || startUri.UserInfo.Length != 0)
            throw new ArgumentException("A credential-free HTTPS start URI is required.", nameof(startUri));
        origin = startUri;
    }

    public bool Allows(string? source) => Uri.TryCreate(source, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps && uri.UserInfo.Length == 0
        && string.Equals(uri.IdnHost, origin.IdnHost, StringComparison.OrdinalIgnoreCase)
        && uri.Port == origin.Port;
}
