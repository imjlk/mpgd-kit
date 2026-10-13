using System.Diagnostics.CodeAnalysis;

namespace Mpgd.MicrosoftStore.Host;

public sealed class NativeBridgeRequestGate
{
    private readonly HashSet<string> activeRequestIds = new(StringComparer.Ordinal);
    private readonly int maximumPendingRequests;
    private readonly object sync = new();
    private int pendingRequests;

    public NativeBridgeRequestGate(
        int maximumPendingRequests = 64)
    {
        if (maximumPendingRequests < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumPendingRequests));
        }
        this.maximumPendingRequests = maximumPendingRequests;
    }

    public bool TryEnter(
        string requestId,
        [NotNullWhen(true)] out NativeBridgeRequestLease? lease,
        out string errorCode)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        lock (sync)
        {
            lease = null;
            if (activeRequestIds.Contains(requestId))
            {
                errorCode = NativeBridgeProtocol.DuplicateRequestError;
                return false;
            }
            if (pendingRequests >= maximumPendingRequests)
            {
                errorCode = NativeBridgeProtocol.BridgeBusyError;
                return false;
            }

            activeRequestIds.Add(requestId);
            pendingRequests += 1;
            lease = new NativeBridgeRequestLease(() => Release(requestId));
            errorCode = string.Empty;
            return true;
        }
    }

    private void Release(string requestId)
    {
        lock (sync)
        {
            if (pendingRequests < 1 || !activeRequestIds.Remove(requestId))
            {
                throw new InvalidOperationException("Native bridge request lease underflow.");
            }
            pendingRequests -= 1;
        }
    }
}

public sealed class NativeBridgeRequestLease : IDisposable
{
    private Action? release;

    internal NativeBridgeRequestLease(Action release)
    {
        this.release = release;
    }

    public void Dispose()
    {
        Interlocked.Exchange(ref release, null)?.Invoke();
    }
}
