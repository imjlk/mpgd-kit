using Microsoft.UI.Dispatching;

namespace Mpgd.MicrosoftStore.Host;

public sealed class DispatcherQueueBridgeDispatcher(DispatcherQueue queue) : INativeBridgeDispatcher
{
    public async Task RunAsync(Func<Task> callback, CancellationToken cancellation)
    {
        ArgumentNullException.ThrowIfNull(callback);
        cancellation.ThrowIfCancellationRequested();
        if (queue.HasThreadAccess)
        {
            await callback();
            return;
        }
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int state = 0; // queued, running, cancelled-before-start
        using var registration = cancellation.Register(() =>
        {
            if (Interlocked.CompareExchange(ref state, 2, 0) == 0)
                completion.TrySetCanceled(cancellation);
        });
        if (!queue.TryEnqueue(async () =>
        {
            if (Interlocked.CompareExchange(ref state, 1, 0) != 0) return;
            try
            {
                cancellation.ThrowIfCancellationRequested();
                await callback();
                completion.TrySetResult();
            }
            catch (OperationCanceledException error) { completion.TrySetCanceled(error.CancellationToken); }
            catch (Exception error) { completion.TrySetException(error); }
        })) completion.TrySetException(new InvalidOperationException("The window dispatcher is unavailable."));
        // After starting, wait for the native operation to finish even if it
        // ignores cancellation; the host's serialization lease must stay held.
        await completion.Task.ConfigureAwait(false);
    }
}
