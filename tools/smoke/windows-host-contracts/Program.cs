using System.Text.Json;
using Mpgd.MicrosoftStore.Host;

int checks = 0;
void Assert(bool value, string name) { if (!value) throw new Exception(name); checks++; }
string Message(string id, string method = "identity.signIn", object? payload = null) =>
    JsonSerializer.Serialize(new { protocol = NativeBridgeProtocol.Protocol, requestId = id, method, payload = payload ?? new { } });
bool Ok(string response) => JsonDocument.Parse(response).RootElement.GetProperty("ok").GetBoolean();
var wireFixtures = new Dictionary<string, string>();
string envelope = JsonSerializer.Serialize(new { transport = WebView2DocumentTransport.Protocol,
    documentNonce = new string('a', 32), request = JsonSerializer.Deserialize<JsonElement>(Message("document")) });
Assert(WebView2DocumentTransport.TryReadRequest(envelope, out var docNonce, out var docRequest)
    && docNonce == new string('a', 32) && docRequest == Message("document"), "document envelope preserves v1 request");
foreach (string invalidEnvelope in new[] { Message("unwrapped"), "null", "{", envelope.Replace(new string('a', 32), "bad-nonce"),
    envelope.Replace(WebView2DocumentTransport.Protocol, "other"), new string('x', 66049) })
    Assert(!WebView2DocumentTransport.TryReadRequest(invalidEnvelope, out _, out _), "reject malformed document transport");
var allowed = new HashSet<string>(["wire.coins"], StringComparer.Ordinal);
var wireOperations = new Operations("wire.coins");
foreach (BridgeCommand command in new BridgeCommand[] { new GetCatalogDetailsCommand("wire", ["wire.coins"]), new SignInCommand("wire"), new ListPurchasesCommand("wire"), new RequestPurchaseCommand("wire", "wire.coins") })
{
    object result = command switch
    {
        GetCatalogDetailsCommand catalog => await wireOperations.GetDetailsAsync(catalog, default),
        SignInCommand => await wireOperations.SignInAsync(default),
        ListPurchasesCommand => await wireOperations.ListPurchasesAsync(default),
        RequestPurchaseCommand purchase => await wireOperations.RequestPurchaseAsync(purchase, default),
        _ => throw new Exception(),
    };
    wireFixtures[command.Method] = NativeBridgeResult.Success(command, result, allowed);
}
var largeIds = Enumerable.Range(0, 64).Select(index => $"wire.coins.{index}").ToArray();
var largeAllowed = new HashSet<string>(largeIds, StringComparer.Ordinal);
var largeItems = largeIds.Select(id => new NativeProductDetail(id, "Localized coins", new string('한', 4096), new("USD", "$1.00"))).ToArray();
wireFixtures["catalog.getDetails.large"] = NativeBridgeResult.Success(new GetCatalogDetailsCommand("large", largeIds), new NativeProductDetailsResult(largeItems), largeAllowed);
Assert(wireFixtures["catalog.getDetails.large"].Length > NativeBridgeProtocol.MaximumMessageLength, "valid large catalog response is not limited by request size");
using (var largeHost = new NativeBridgeHost(new(new Uri("https://wire.example.invalid/")), largeIds.Append("wire.coins"), wireOperations, new Dispatcher(), _ => { }))
    Assert(largeHost.ActivateDocument("https://wire.example.invalid/"), "configured product allowlist may exceed per-request item limit");
foreach (string malformed in new[] { "null", "{}", "{", new string('x', 65537), Message("bad", "catalog.getDetails", new { itemIds = Array.Empty<string>() }), Message("bad", "identity.signIn", new { extra = true }), Message("bad", "purchase.request", new { itemId = "wire.coins", extra = true }), Message("bad", "catalog.getDetails", new { itemIds = new[] { "wire.coins", "wire.coins" } }), Message("bad", "unknown.method") })
    Assert(!NativeBridgeProtocol.TryParseCommand(malformed, allowed, out _, out _), "reject malformed protocol request");
void InvalidResult(BridgeCommand command, object result)
{
    bool rejected = false;
    try { NativeBridgeResult.Success(command, result, allowed); }
    catch (InvalidOperationException) { rejected = true; }
    Assert(rejected, "reject invalid response");
}
InvalidResult(new SignInCommand("test"), new NativePlayerSession(DateTimeOffset.UtcNow.AddSeconds(30).ToUnixTimeMilliseconds(), "player", new string('s', 64)));
InvalidResult(new SignInCommand("test"), new NativePlayerSession(DateTimeOffset.UtcNow.AddSeconds(90).ToUnixTimeMilliseconds(), "player", new string('s', 64)));
InvalidResult(new SignInCommand("test"), new NativePlayerSession(DateTimeOffset.UtcNow.AddDays(2).ToUnixTimeMilliseconds(), "player", new string('s', 64)));
InvalidResult(new SignInCommand("test"), new NativePlayerSession(DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds(), " player ", new string('s', 64)));
InvalidResult(new ListPurchasesCommand("test"), new NativePurchasesResult([new("wire.coins", "wire.coins"), new("wire.coins", "wire.coins")]));
InvalidResult(new ListPurchasesCommand("test"), new NativePurchasesResult([new("wire.coins", "wrong.token")]));
InvalidResult(new RequestPurchaseCommand("test", "wire.coins"), new NativePurchaseResult("succeeded", "wrong.token"));
InvalidResult(new RequestPurchaseCommand("test", "wire.coins"), new NativePurchaseResult("not-purchased", "wire.coins"));
InvalidResult(new GetCatalogDetailsCommand("test", ["wire.coins"]), new NativeProductDetailsResult([new("other.coins", "Coins", null, new("USD", "$1.00"))]));

foreach (string game in new[] { "puzzle", "tower" })
{
    string source = $"https://{game}.example.invalid/index.html";
    string item = game + ".coins";
    var policy = new NativeBridgeOrigin(new Uri(source));
    Assert(policy.Allows(source) && !policy.Allows("https://evil.invalid/") && !policy.Allows(source.Replace("https:", "http:")), "origin isolation");
    Assert(!policy.Allows($"https://user@{game}.example.invalid/") && !policy.Allows($"https://{game}.example.invalid:444/"), "credentials and ports");
    var operations = new Operations(item);
    var responses = new List<string>();
    var dispatcher = new Dispatcher();
    using var host = new NativeBridgeHost(policy, [item], operations, dispatcher, responses.Add, maximumPendingRequests: 2);
    Assert(host.ActivateDocument(source), "activate");
    await host.HandleMessageAsync("https://evil.invalid/", Message("wrong"));
    Assert(responses.Count == 0 && operations.Calls == 0, "reject other origin before callback");
    await host.HandleMessageAsync(source, Message("sku", "purchase.request", new { itemId = "other.coins" }));
    Assert(responses.Single().Contains("PRODUCT_NOT_ALLOWED") && operations.Calls == 0, "SKU policy injected");
    responses.Clear();
    await host.HandleMessageAsync(source, Message("signin"));
    Assert(Ok(responses.Single()) && responses.Single().Contains("sessionToken") && !responses.Single().Contains("serviceTicket")
        && JsonDocument.Parse(responses.Single()).RootElement.GetProperty("result").GetProperty("expiresAt").ValueKind == JsonValueKind.Number, "typed session response");
    responses.Clear();
    await host.HandleMessageAsync(source, Message("future", "future.method"));
    Assert(responses.Single().Contains("UNSUPPORTED_METHOD"), "unknown valid method fails without a timeout");
    responses.Clear();
    await host.HandleMessageAsync(source, Message("catalog", "catalog.getDetails", new { itemIds = new[] { item } }));
    await host.HandleMessageAsync(source, Message("list", "purchase.list"));
    await host.HandleMessageAsync(source, Message("buy", "purchase.request", new { itemId = item }));
    Assert(responses.Count == 3 && responses.All(Ok) && dispatcher.Calls >= 8, "all callbacks dispatched with compatible wire results");
    responses.Clear();
    operations.Error = new Exception("secret-service-ticket");
    await host.HandleMessageAsync(source, Message("failure"));
    Assert(responses.Single().Contains("NATIVE_OPERATION_FAILED") && !responses.Single().Contains("secret"), "sanitize exception");
    operations.Error = new NativeBridgeOperationException(NativeBridgeFailure.UserCancelled);
    responses.Clear();
    await host.HandleMessageAsync(source, Message("cancel-user"));
    Assert(responses.Single().Contains("USER_CANCELLED"), "declared failure");
    responses.Clear();
    await host.HandleMessageAsync(source, Message("cancel-purchase", "purchase.request", new { itemId = item }));
    Assert(Ok(responses.Single()) && responses.Single().Contains("not-purchased"), "checkout cancellation uses the public non-purchase result");
    wireFixtures["purchase.request.cancel"] = responses.Single();
    operations.Error = null;
    operations.InvalidResult = true;
    responses.Clear();
    await host.HandleMessageAsync(source, Message("invalid-result"));
    Assert(!Ok(responses.Single()), "invalid typed result rejected");
    operations.InvalidResult = false;
    responses.Clear();
    operations.Block = new(TaskCreationOptions.RunContinuationsAsynchronously);
    int callsBefore = operations.Calls;
    Task active = host.HandleMessageAsync(source, Message("active"));
    Task queued = host.HandleMessageAsync(source, Message("queued"));
    await host.HandleMessageAsync(source, Message("active"));
    await host.HandleMessageAsync(source, Message("busy"));
    Assert(responses.Count == 2 && responses.Any(r => r.Contains("DUPLICATE_REQUEST")) && responses.Any(r => r.Contains("BRIDGE_BUSY")), "bounded active requests");
    responses.Clear();
    host.InvalidateDocument();
    host.ActivateDocument(source);
    operations.Block.SetResult(); // Simulate an SDK ignoring cancellation.
    await Task.WhenAll(active, queued);
    Assert(responses.Count == 0 && operations.Calls == callsBefore + 1, "navigation cancels queue and suppresses late response");
    operations.Block = null;
    await host.HandleMessageAsync(source, Message("active"));
    Assert(Ok(responses.Single()), "new document may reuse request ID");
    responses.Clear();
    using var cancellation = new CancellationTokenSource();
    operations.Block = new(TaskCreationOptions.RunContinuationsAsynchronously);
    active = host.HandleMessageAsync(source, Message("hold"));
    queued = host.HandleMessageAsync(source, Message("external-cancel"), cancellation.Token);
    cancellation.Cancel();
    operations.Block.SetResult();
    await Task.WhenAll(active, queued);
    Assert(responses.Count == 1, "caller cancellation removes queued operation");
    responses.Clear();
    operations.Block = new(TaskCreationOptions.RunContinuationsAsynchronously);
    operations.ThrowOnCancel = true;
    active = host.HandleMessageAsync(source, Message("close"));
    host.Dispose();
    operations.Block.SetResult();
    await active;
    Assert(responses.Count == 0 && !host.ActivateDocument(source), "closed window suppresses response");
}
var localized = NativeBridgeResult.Success(new GetCatalogDetailsCommand("localized", ["wire.coins"]),
    new NativeProductDetailsResult([new("wire.coins", "سکه\u200Cها", "👨\u200D👩\u200D👧", new("USD", "\u200F$1.00"))]), allowed);
using (var display = JsonDocument.Parse(localized))
    Assert(display.RootElement.GetProperty("result").GetProperty("items")[0].GetProperty("title").GetString() == "سکه\u200Cها", "localized display text accepts joiners and direction marks");
InvalidResult(new GetCatalogDetailsCommand("bad-text", ["wire.coins"]),
    new NativeProductDetailsResult([new("wire.coins", "unsafe\u202Etitle", null, new("USD", "$1.00"))]));
wireFixtures["catalog.getDetails.localized"] = localized;
if (args.Length == 1) File.WriteAllText(args[0], JsonSerializer.Serialize(wireFixtures));
Console.WriteLine($"Native host contract checks passed: {checks}");

sealed class Dispatcher : INativeBridgeDispatcher
{
    public int Calls;
    public Task RunAsync(Func<Task> callback, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        Calls++;
        return callback();
    }
}

sealed class Operations(string item) : INativeStoreOperations
{
    public int Calls;
    public Exception? Error;
    public bool InvalidResult;
    public bool ThrowOnCancel;
    public TaskCompletionSource? Block;
    public async Task<NativePlayerSession> SignInAsync(CancellationToken cancellation)
    {
        Calls++;
        using var cancellationRegistration = ThrowOnCancel ? cancellation.Register(() => throw new InvalidOperationException("fixture cancellation callback")) : default;
        if (Block is { } blocked) await blocked.Task;
        if (Error is { } error) throw error;
        return new(DateTimeOffset.UtcNow.AddMinutes(15).ToUnixTimeMilliseconds(), "fixture-player", InvalidResult ? "bad" : new string('s', 64));
    }
    public Task<NativeProductDetailsResult> GetDetailsAsync(GetCatalogDetailsCommand command, CancellationToken cancellation)
    {
        Calls++;
        return Task.FromResult(new NativeProductDetailsResult([new(item, "Coins", null, new("USD", "$1.00"))]));
    }
    public Task<NativePurchasesResult> ListPurchasesAsync(CancellationToken cancellation)
    {
        Calls++;
        return Task.FromResult(new NativePurchasesResult([new(item, item)]));
    }
    public Task<NativePurchaseResult> RequestPurchaseAsync(RequestPurchaseCommand command, CancellationToken cancellation)
    {
        Calls++;
        return Error is { } error ? Task.FromException<NativePurchaseResult>(error)
            : Task.FromResult(new NativePurchaseResult("succeeded", item));
    }
}
