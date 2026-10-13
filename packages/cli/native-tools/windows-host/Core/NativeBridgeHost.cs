namespace Mpgd.MicrosoftStore.Host;

/// <summary>A window-owned native bridge. InvalidateDocument on every top-level
/// navigation start, activate when an allowed document commits, invalidate on
/// navigation failure, and dispose when the window closes. PostResponse must
/// synchronously send JSON.</summary>
public sealed class NativeBridgeHost : IDisposable
{
    private readonly NativeBridgeOrigin origin;
    private readonly HashSet<string> allowedItems;
    private readonly INativeStoreOperations operations;
    private readonly INativeBridgeDispatcher dispatcher;
    private readonly Action<string> postResponse;
    private readonly SemaphoreSlim serial = new(1, 1);
    private readonly object sync = new();
    private Document? document;
    private bool closed;
    private readonly int maximumPendingRequests;

    private sealed record Document(CancellationTokenSource Lifetime, NativeBridgeRequestGate Gate);

    public NativeBridgeHost(NativeBridgeOrigin origin, IEnumerable<string> allowedItemIds,
        INativeStoreOperations operations, INativeBridgeDispatcher dispatcher,
        Action<string> postResponse, int maximumPendingRequests = 64)
    {
        ArgumentNullException.ThrowIfNull(origin);
        ArgumentNullException.ThrowIfNull(allowedItemIds);
        ArgumentNullException.ThrowIfNull(operations);
        ArgumentNullException.ThrowIfNull(dispatcher);
        ArgumentNullException.ThrowIfNull(postResponse);
        if (maximumPendingRequests < 1) throw new ArgumentOutOfRangeException(nameof(maximumPendingRequests));
        this.origin = origin;
        allowedItems = new(allowedItemIds, StringComparer.Ordinal);
        if (allowedItems.Any(item => !NativeBridgeProtocol.IsValidIdentifier(item, NativeBridgeProtocol.MaximumItemIdLength)))
            throw new ArgumentException("Invalid product allowlist.", nameof(allowedItemIds));
        this.operations = operations;
        this.dispatcher = dispatcher;
        this.postResponse = postResponse;
        this.maximumPendingRequests = maximumPendingRequests;
    }

    public bool ActivateDocument(string source)
    {
        InvalidateDocument();
        lock (sync)
        {
            if (closed || !origin.Allows(source)) return false;
            document = new(new(), new(maximumPendingRequests));
            return true;
        }
    }

    public void InvalidateDocument()
    {
        Document? previous;
        lock (sync)
        {
            previous = document;
            document = null;
        }
        // Cancellation callbacks are game code and must run outside the state lock.
        try { previous?.Lifetime.Cancel(); }
        catch (AggregateException)
        {
            // Cancel invokes every registered callback before aggregating its
            // exceptions. State is already revoked; a game callback must not
            // abort window cleanup or allow an old document to publish again.
        }
    }

    public async Task HandleMessageAsync(string source, string message, CancellationToken cancellation = default)
    {
        Document current;
        lock (sync)
        {
            if (closed || document is null || !origin.Allows(source)) return;
            current = document;
        }
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(current.Lifetime.Token, cancellation);
        var token = linked.Token;
        try
        {
            if (!NativeBridgeProtocol.TryParseCommand(message, allowedItems, out var command, out var parseError) || command is null)
            {
                if (NativeBridgeProtocol.TryReadRouting(message, out var id, out var method))
                    await SendAsync(current, NativeBridgeResult.Failure(id, method, parseError), token).ConfigureAwait(false);
                return;
            }
            if (!current.Gate.TryEnter(command.RequestId, out var lease, out var gateError))
            {
                await SendAsync(current, NativeBridgeResult.Failure(command.RequestId, command.Method, gateError), token).ConfigureAwait(false);
                return;
            }
            using (lease)
            {
                await serial.WaitAsync(token).ConfigureAwait(false);
                string response;
                try
                {
                    token.ThrowIfCancellationRequested();
                    string? success = null;
                    await dispatcher.RunAsync(async () =>
                    {
                        token.ThrowIfCancellationRequested();
                        object result = command switch
                        {
                            GetCatalogDetailsCommand catalog => await operations.GetDetailsAsync(catalog, token),
                            SignInCommand => await operations.SignInAsync(token),
                            ListPurchasesCommand => await operations.ListPurchasesAsync(token),
                            RequestPurchaseCommand purchase => await operations.RequestPurchaseAsync(purchase, token),
                            _ => throw new InvalidOperationException(),
                        };
                        token.ThrowIfCancellationRequested();
                        success = NativeBridgeResult.Success(command, result, allowedItems);
                    }, token).ConfigureAwait(false);
                    response = success ?? throw new InvalidOperationException();
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                catch (NativeBridgeOperationException error)
                {
                    string code = error.Failure switch
                    {
                        NativeBridgeFailure.UserCancelled => "USER_CANCELLED",
                        NativeBridgeFailure.IdentityUnavailable => "IDENTITY_UNAVAILABLE",
                        NativeBridgeFailure.StoreUnavailable => "STORE_UNAVAILABLE",
                        _ => "NATIVE_OPERATION_FAILED",
                    };
                    response = NativeBridgeResult.Failure(command.RequestId, command.Method, code);
                }
                catch { response = NativeBridgeResult.Failure(command.RequestId, command.Method, "NATIVE_OPERATION_FAILED"); }
                finally { serial.Release(); }
                await SendAsync(current, response, token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private Task SendAsync(Document current, string response, CancellationToken token) => dispatcher.RunAsync(() =>
    {
        lock (sync)
        {
            if (!closed && ReferenceEquals(document, current) && !token.IsCancellationRequested)
                postResponse(response);
        }
        return Task.CompletedTask;
    }, token);

    public void Dispose()
    {
        lock (sync) { if (closed) return; closed = true; }
        InvalidateDocument();
        // In-flight callbacks retain their document and may still observe its
        // token. The semaphore remains valid until this host is collected.
    }
}
