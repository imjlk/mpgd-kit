namespace KitStarterHost;

// The observer reads this snapshot while the host keeps publishing it. Windows
// can briefly refuse replacement when another process holds a non-delete-shared
// handle. Retry publication only; permanent failures still reach RecordFailure.
internal static class ReadinessFile
{
    internal static async Task WriteAsync(string path, string json,
        Action<string, string>? replace = null, Func<TimeSpan, Task>? delay = null)
    {
        replace ??= (source, destination) => File.Move(source, destination, true);
        delay ??= duration => Task.Delay(duration);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, json);
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    replace(temporary, path);
                    return;
                }
                catch (Exception error) when (attempt < 4 && IsReplaceContention(error))
                {
                    // Five total attempts, at most 750 ms of asynchronous delay.
                    await delay(TimeSpan.FromMilliseconds(50 * (1 << attempt)));
                }
            }
        }
        catch
        {
            // Preserve the publication error if cleanup is also denied. The
            // uniquely named temporary file cannot belong to another probe.
            try { File.Delete(temporary); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            throw;
        }
    }

    private static bool IsReplaceContention(Exception error) =>
        error is IOException or UnauthorizedAccessException &&
        error.HResult is unchecked((int)0x80070005) // ERROR_ACCESS_DENIED
            or unchecked((int)0x80070020) // ERROR_SHARING_VIOLATION
            or unchecked((int)0x80070021); // ERROR_LOCK_VIOLATION
}
