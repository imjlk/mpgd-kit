using Microsoft.UI.Xaml;
using Windows.Services.Store;

namespace Mpgd.MicrosoftStore.Host;

/// <summary>Call on the owning window's UI thread before starting Store UI.</summary>
public static class WindowStoreContext
{
    public static StoreContext Create(Window window)
    {
        ArgumentNullException.ThrowIfNull(window);
        if (!window.DispatcherQueue.HasThreadAccess)
            throw new InvalidOperationException("StoreContext must be initialized on its window's UI thread.");
        var handle = WinRT.Interop.WindowNative.GetWindowHandle(window);
        if (handle == IntPtr.Zero) throw new InvalidOperationException("The native window is not initialized.");
        var context = StoreContext.GetDefault();
        WinRT.Interop.InitializeWithWindow.Initialize(context, handle);
        return context;
    }
}
