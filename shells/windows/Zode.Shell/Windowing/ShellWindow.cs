// Windowing/ShellWindow.cs — the borderless top-level window.
//
// Contract §5 rules implemented here:
//   1. No native window controls (no caption, no min/max/close, no system menu).
//   2. The web content owns the entire window (no shell painting over it).
//   3. The top strip (DRAG_ZONE_HEIGHT = 34) is the drag zone.
//   4. Double-click on the strip fills the screen with this app window
//      (entire monitor bounds, NOT the work area, and never real fullscreen).
//   5. Everything below the strip is not draggable.
//
// The window is created with WS_POPUP | WS_THICKFRAME | WS_CLIPCHILDREN and
// WM_NCCALCSIZE returns 0, which removes the whole non-client area.

using System.Runtime.InteropServices;
using Zode.Shell.Diagnostics;
using Zode.Shell.Native;

namespace Zode.Shell.Windowing;

internal sealed class ShellWindow : IDisposable
{
    /// <summary>
    /// Height of the drag strip, in pixels.  Contract §5.3 declares
    /// DRAG_ZONE_HEIGHT = 34 and the web app exports the same value as the
    /// CSS custom property --drag-zone-height.
    /// </summary>
    public const int DRAG_ZONE_HEIGHT = 34;

    /// <summary>Width of the invisible resize border, in pixels (contract §5).</summary>
    public const int RESIZE_BORDER = 8;

    private const string WindowClassName = "Zode.Shell.NativeWindow";
    private const string WindowTitle = "Zode";

    private readonly NativeMethods.WindowProc _wndProc;
    private readonly FillScreenController _fill;
    private IntPtr _hwnd;
    private bool _disposed;

    public ShellWindow()
    {
        _wndProc = WndProc;
        _fill = new FillScreenController(() => Handle);

        IntPtr module = GetModuleHandle(null);
        var wc = new NativeMethods.WNDCLASSEX
        {
            // sizeof(WNDCLASSEX): 80 bytes on x64, 48 bytes on x86.
            cbSize = (uint)(IntPtr.Size == 8 ? 80 : 48),
            style = 0,
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProc),
            cbClsExtra = 0,
            cbWndExtra = 0,
            hInstance = module,
            hIcon = IntPtr.Zero,
            hCursor = NativeMethods.LoadCursorW(IntPtr.Zero, WindowConstants.IDC_ARROW),
            // No background brush: the web content paints the whole window (contract §5.2).
            hbrBackground = IntPtr.Zero,
            lpszMenuName = null,
            lpszClassName = WindowClassName,
            hIconSm = IntPtr.Zero,
        };

        if (NativeMethods.RegisterClassExW(ref wc) == 0)
        {
            throw new InvalidOperationException(
                $"RegisterClassEx failed for {WindowClassName} (win32 error {Marshal.GetLastWin32Error()}).");
        }

        (int x, int y, int width, int height) = InitialBounds();

        _hwnd = NativeMethods.CreateWindowExW(
            0,
            WindowClassName,
            WindowTitle,
            // Borderless: no caption, no system menu, no min/max/close buttons.
            WindowConstants.WS_POPUP | WindowConstants.WS_THICKFRAME | WindowConstants.WS_CLIPCHILDREN,
            x, y, width, height,
            IntPtr.Zero, IntPtr.Zero, module, IntPtr.Zero);

        if (_hwnd == IntPtr.Zero)
        {
            throw new InvalidOperationException(
                $"CreateWindowEx failed (win32 error {Marshal.GetLastWin32Error()}).");
        }

        Log.Info("window", $"created borderless window {WindowTitle} ({width}x{height})");
    }

    public IntPtr Handle => _hwnd;

    public bool IsFilling => _fill.IsFilling;

    /// <summary>Raised when the client area changed size; the WebView2 child follows.</summary>
    public event EventHandler? ClientSizeChanged;

    /// <summary>
    /// Raised when the UI thread has queued work for the dispatcher (the
    /// WM_APP_DISPATCH message of Native/UiDispatcher.cs).
    /// </summary>
    public event EventHandler? DispatchRequested;

    public void Show()
    {
        NativeMethods.ShowWindow(_hwnd, WindowConstants.SW_SHOWNORMAL);
        NativeMethods.UpdateWindow(_hwnd);
        NativeMethods.SetForegroundWindow(_hwnd);
    }

    /// <summary>
    /// Starts an OS-level window drag (contract §5.3).  This is the classic
    /// ReleaseCapture + SendMessage(WM_NCLBUTTONDOWN, HTCAPTION) dance: the
    /// window manager takes over the pointer and drags the window with the
    /// native snap/animation behaviour.
    /// </summary>
    public void BeginDrag()
    {
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        NativeMethods.ReleaseCapture();
        NativeMethods.SendMessageW(_hwnd, WindowConstants.WM_NCLBUTTONDOWN, (IntPtr)WindowConstants.HTCAPTION, IntPtr.Zero);
    }

    /// <summary>Toggles "fill the screen with this app window" (contract §5.4).</summary>
    public bool ToggleFillScreen() => _fill.Toggle();

    /// <summary>
    /// The contract exposes setFullScreen/isFullScreen next to the fill
    /// behaviour.  On Windows the shell deliberately never enters *real*
    /// fullscreen (that would hide the taskbar and switch Space); "full
    /// screen" therefore means "fill the entire display bounds".
    /// </summary>
    public void SetFullScreen(bool fullScreen)
    {
        if (fullScreen)
        {
            _fill.Fill();
        }
        else
        {
            _fill.Restore();
        }
    }

    public bool IsFullScreen() => _fill.IsFilling;

    // ------------------------------------------------------------------
    // Window procedure
    // ------------------------------------------------------------------
    private IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        switch (msg)
        {
            case WindowConstants.WM_NCCALCSIZE:
                if (wParam != IntPtr.Zero)
                {
                    // Remove the entire non-client area: this is what actually
                    // makes the caption / minimise / maximise / close vanish.
                    return IntPtr.Zero;
                }

                break;

            case WindowConstants.WM_NCHITTEST:
                return (IntPtr)HitTest(lParam, captionForStrip: true);

            case WindowConstants.WM_NCLBUTTONDBLCLK:
                if (wParam == (IntPtr)WindowConstants.HTCAPTION)
                {
                    // The OS would maximise the caption; we fill the screen instead.
                    _fill.Toggle();
                    return IntPtr.Zero;
                }

                break;

            case WindowConstants.WM_SIZE:
                RaiseClientSizeChanged();
                break;

            case WindowConstants.WM_DPICHANGED:
                if (_fill.IsFilling)
                {
                    // Keep filling the (possibly new) monitor.
                    _fill.ReapplyMonitorBounds();
                }
                else
                {
                    var suggested = Marshal.PtrToStructure<NativeMethods.RECT>(lParam);
                    NativeMethods.SetWindowPos(hWnd, IntPtr.Zero,
                        suggested.Left, suggested.Top, suggested.Width, suggested.Height,
                        WindowConstants.SWP_NOZORDER | WindowConstants.SWP_NOACTIVATE);
                }

                RaiseClientSizeChanged();
                break;

            case WindowConstants.WM_DISPLAYCHANGE:
                if (_fill.IsFilling)
                {
                    _fill.ReapplyMonitorBounds();
                }

                break;

            case WindowConstants.WM_GETMINMAXINFO:
                // A minimum size keeps the window usable while resizing.
                var info = Marshal.PtrToStructure<NativeMethods.MINMAXINFO>(lParam);
                info.ptMinTrackSize.X = 480;
                info.ptMinTrackSize.Y = 360;
                Marshal.StructureToPtr(info, lParam, false);
                break;

            case WindowConstants.WM_ERASEBKGND:
                // Nothing is painted by the shell: the web view covers the window.
                return (IntPtr)1;

            case WindowConstants.WM_APP_DISPATCH:
                DispatchRequested?.Invoke(this, EventArgs.Empty);
                break;

            case WindowConstants.WM_CLOSE:
                NativeMethods.DestroyWindow(hWnd);
                return IntPtr.Zero;

            case WindowConstants.WM_DESTROY:
                NativeMethods.PostQuitMessage(0);
                return IntPtr.Zero;
        }

        return NativeMethods.DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    private void RaiseClientSizeChanged() => ClientSizeChanged?.Invoke(this, EventArgs.Empty);

    /// <summary>
    /// Invisible resize border + drag strip hit testing (contract §5).
    /// <paramref name="captionForStrip"/> is true for the top-level window
    /// (the OS drags the window) and false for the WebView2 child, where the
    /// top strip must stay HTCLIENT so that the page can raise the
    /// window.dragStart / dblclick events of contract §3.
    /// </summary>
    internal static int HitTest(int clientX, int clientY, int width, int height, bool captionForStrip)
    {
        bool left = clientX < RESIZE_BORDER;
        bool right = clientX >= width - RESIZE_BORDER;
        bool top = clientY < RESIZE_BORDER;
        bool bottom = clientY >= height - RESIZE_BORDER;

        if (clientY < DRAG_ZONE_HEIGHT)
        {
            if (left && top)
            {
                return WindowConstants.HTTOPLEFT;
            }

            if (right && top)
            {
                return WindowConstants.HTTOPRIGHT;
            }

            return captionForStrip ? WindowConstants.HTCAPTION : WindowConstants.HTCLIENT;
        }

        if (left)
        {
            return WindowConstants.HTLEFT;
        }

        if (right)
        {
            return WindowConstants.HTRIGHT;
        }

        if (bottom)
        {
            return WindowConstants.HTBOTTOM;
        }

        return WindowConstants.HTCLIENT;
    }

    private int HitTest(IntPtr lParam, bool captionForStrip) =>
        HitTestScreen(_hwnd, lParam, captionForStrip);

    /// <summary>
    /// Screen coordinates (as delivered in WM_NCHITTEST) to a hit-test code.
    /// Shared by the top-level window and the WebView2 child subclass.
    /// </summary>
    internal static int HitTestScreen(IntPtr hwnd, IntPtr lParam, bool captionForStrip)
    {
        int x = NativeMethods.GET_X_LPARAM(lParam);
        int y = NativeMethods.GET_Y_LPARAM(lParam);
        NativeMethods.ScreenToClient(hwnd, ref x, ref y);
        NativeMethods.GetClientRect(hwnd, out NativeMethods.RECT rect);
        return HitTest(x, y, rect.Width, rect.Height, captionForStrip);
    }

    private static (int x, int y, int width, int height) InitialBounds()
    {
        const int defaultWidth = 1280;
        const int defaultHeight = 800;

        IntPtr monitor = NativeMethods.MonitorFromPoint(new NativeMethods.POINT(0, 0),
            WindowConstants.MONITOR_DEFAULTTOPRIMARY);
        var info = new NativeMethods.MONITORINFO
        {
            cbSize = Marshal.SizeOf<NativeMethods.MONITORINFO>(),
        };

        if (NativeMethods.GetMonitorInfoW(monitor, ref info))
        {
            int workWidth = info.rcWork.Width;
            int workHeight = info.rcWork.Height;
            int width = Math.Min(defaultWidth, Math.Max(640, workWidth - 80));
            int height = Math.Min(defaultHeight, Math.Max(480, workHeight - 80));
            int x = info.rcWork.Left + (workWidth - width) / 2;
            int y = info.rcWork.Top + (workHeight - height) / 2;
            return (x, y, width, height);
        }

        return (100, 100, defaultWidth, defaultHeight);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        if (_hwnd != IntPtr.Zero)
        {
            NativeMethods.DestroyWindow(_hwnd);
            _hwnd = IntPtr.Zero;
        }
    }
}
