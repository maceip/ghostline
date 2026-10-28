// Native/WindowSubclass.cs — tiny WndProc subclassing helper.
//
// The WebView2 renderer is a child HWND that covers the whole client area, so
// the parent window never sees mouse input over the web content.  To keep the
// invisible resize border usable we subclass the child and answer
// WM_NCHITTEST ourselves (contract §5).

using System.Runtime.InteropServices;

namespace Zode.Shell.Native;

internal sealed class WindowSubclass : IDisposable
{
    private const int GWLP_WNDPROC = -4;

    private readonly IntPtr _hwnd;
    private readonly NativeMethods.WindowProc _proc;
    private readonly IntPtr _originalProc;
    private bool _disposed;

    private WindowSubclass(IntPtr hwnd, NativeMethods.WindowProc proc, IntPtr originalProc)
    {
        _hwnd = hwnd;
        _proc = proc;
        _originalProc = originalProc;
    }

    public static WindowSubclass Attach(IntPtr hwnd, NativeMethods.WindowProc proc)
    {
        IntPtr original = NativeMethods.GetWindowLongPtr(hwnd, GWLP_WNDPROC);
        IntPtr replacement = Marshal.GetFunctionPointerForDelegate(proc);
        NativeMethods.SetWindowLongPtr(hwnd, GWLP_WNDPROC, replacement);
        return new WindowSubclass(hwnd, proc, original);
    }

    /// <summary>Forwards a message to the window procedure that was replaced.</summary>
    public IntPtr CallOriginal(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam) =>
        NativeMethods.CallWindowProcW(_originalProc, hwnd, msg, wParam, lParam);

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        NativeMethods.SetWindowLongPtr(_hwnd, GWLP_WNDPROC, _originalProc);
    }
}
