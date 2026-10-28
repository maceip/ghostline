// Native/UiDispatcher.cs — marshals work onto the shell's UI thread.
//
// The WebView2 environment is created asynchronously on a thread-pool thread,
// but window and WebView2 controller creation must happen on the thread that
// owns the message pump.  This SynchronizationContext posts to the main
// window with WM_APP_DISPATCH, which the shell's WndProc drains.

using System.Collections.Concurrent;
using Zode.Shell.Diagnostics;

namespace Zode.Shell.Native;

internal sealed class UiDispatcher : SynchronizationContext
{
    private readonly ConcurrentQueue<Action> _queue = new();
    private IntPtr _hwnd;

    public UiDispatcher(IntPtr hwnd) => _hwnd = hwnd;

    public IntPtr WindowHandle
    {
        get => _hwnd;
        set => _hwnd = value;
    }

    public override void Post(SendOrPostCallback d, object? state)
    {
        if (d is null)
        {
            return;
        }

        _queue.Enqueue(() => d(state));
        if (_hwnd != IntPtr.Zero)
        {
            NativeMethods.PostMessageW(_hwnd, WindowConstants.WM_APP_DISPATCH, IntPtr.Zero, IntPtr.Zero);
        }
    }

    public override void Send(SendOrPostCallback d, object? state)
    {
        if (_hwnd != IntPtr.Zero &&
            (int)NativeMethods.GetWindowThreadProcessId(_hwnd, out _) == Environment.CurrentManagedThreadId)
        {
            d(state);
            return;
        }

        using var done = new ManualResetEventSlim(false);
        Exception? failure = null;
        Post(_ =>
        {
            try
            {
                d(state);
            }
            catch (Exception ex)
            {
                failure = ex;
            }
            finally
            {
                done.Set();
            }
        }, null);

        done.Wait();
        if (failure is not null)
        {
            throw failure;
        }
    }

    /// <summary>Runs every queued action. Called from the WndProc.</summary>
    public void Drain()
    {
        while (_queue.TryDequeue(out Action? action))
        {
            try
            {
                action();
            }
            catch (Exception ex)
            {
                Log.Error("dispatch", ex);
            }
        }
    }
}
