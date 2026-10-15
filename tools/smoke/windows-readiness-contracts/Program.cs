using KitStarterHost;

int cases = 0;
void Assert(bool value, string message) { if (!value) throw new Exception(message); }
string root = Path.Combine(Path.GetTempPath(), "mpgd-readiness-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
string path = Path.Combine(root, "starter-ready.json");
const string previous = "{\"generation\":1}";
const string next = "{\"generation\":2}";
try
{
    foreach (Exception contention in new Exception[] {
        new UnauthorizedAccessException("temporary access denial"),
        new IOException("sharing violation", unchecked((int)0x80070020)),
        new IOException("lock violation", unchecked((int)0x80070021)) })
    {
        File.WriteAllText(path, previous);
        int attempts = 0;
        var delays = new List<double>();
        await ReadinessFile.WriteAsync(path, next, (source, destination) =>
        {
            Assert(File.ReadAllText(source) == next, "retry preserves the complete new snapshot");
            Assert(File.ReadAllText(destination) == previous, "failed replace preserves the old snapshot");
            if (++attempts < 3) throw contention;
            File.Move(source, destination, true);
        }, duration => { delays.Add(duration.TotalMilliseconds); return Task.CompletedTask; });
        Assert(attempts == 3 && delays.SequenceEqual(new double[] { 50, 100 }), "bounded backoff before success");
        Assert(File.ReadAllText(path) == next, "new snapshot is published");
        Assert(Directory.GetFiles(root, "*.tmp").Length == 0, "successful publication leaves no temporary file");
        cases++;
    }

    File.WriteAllText(path, previous);
    int failedAttempts = 0;
    var failedDelays = new List<double>();
    var permanent = new UnauthorizedAccessException("permanent permission denial");
    try
    {
        await ReadinessFile.WriteAsync(path, next, (_, _) => { failedAttempts++; throw permanent; },
            duration => { failedDelays.Add(duration.TotalMilliseconds); return Task.CompletedTask; });
        throw new Exception("persistent permission denial must fail");
    }
    catch (UnauthorizedAccessException error) { Assert(ReferenceEquals(error, permanent), "original failure is propagated"); }
    Assert(failedAttempts == 5 && failedDelays.SequenceEqual(new double[] { 50, 100, 200, 400 }), "persistent failure exhausts the finite retry budget");
    Assert(File.ReadAllText(path) == previous, "persistent failure does not replace old evidence");
    Assert(Directory.GetFiles(root, "*.tmp").Length == 0, "failed publication cleans its temporary file");
    cases++;

    foreach (Exception fatal in new Exception[] {
        new IOException("disk full", unchecked((int)0x80070070)),
        new InvalidOperationException("unexpected publisher failure") })
    {
        int attempts = 0;
        try
        {
            await ReadinessFile.WriteAsync(path, next, (_, _) => { attempts++; throw fatal; },
                _ => throw new Exception("non-contention failure must not delay"));
            throw new Exception("non-contention failure must propagate");
        }
        catch (Exception error) when (ReferenceEquals(error, fatal)) { }
        Assert(attempts == 1, "unrelated failure is not retried");
        Assert(Directory.GetFiles(root, "*.tmp").Length == 0, "fatal failure cleans its temporary file");
        cases++;
    }

    try
    {
        await ReadinessFile.WriteAsync(Path.Combine(root, "missing", "ready.json"), next,
            (_, _) => throw new Exception("write failure must not enter replace"),
            _ => throw new Exception("write failure must not delay"));
        throw new Exception("missing directory must fail");
    }
    catch (DirectoryNotFoundException) { }
    cases++;

    if (OperatingSystem.IsWindows())
    {
        File.WriteAllText(path, previous);
        using var reader = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        int delays = 0;
        await ReadinessFile.WriteAsync(path, next, delay: _ =>
        {
            delays++;
            // Windows blocks rename while this real reader denies delete sharing.
            reader.Dispose();
            return Task.CompletedTask;
        });
        Assert(delays > 0 && delays <= 4, "real Windows reader contention triggers bounded retry");
        Assert(File.ReadAllText(path) == next, "publication succeeds after the reader releases its handle");
        cases++;
    }
    else Console.WriteLine("Real Windows handle-contention case runs in Windows CI.");
    Console.WriteLine($"Readiness publication contracts passed: {cases} cases.");
}
finally { Directory.Delete(root, recursive: true); }
