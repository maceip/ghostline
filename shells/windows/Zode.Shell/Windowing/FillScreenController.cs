// Windowing/FillScreenController.cs — "fill the screen with this app window".
//
// Contract §5.4:
//   * "Fill" = the window occupies the ENTIRE monitor bounds (not the work
//     area) and the window enters a full-screen-like state WITHOUT hiding the
//     menu bar or switching Space.
//   * The previous WINDOWPLACEMENT is saved and restored on the next toggle.
//
// The shell never calls SetWindowDisplayAffinity and never uses a
// borderless-fullscreen hack: the taskbar stays visible, exactly like the
// macOS implementation which omits .titled instead of using
// NSWindow.toggleFullScreen.

using System.Runtime.InteropServices;
using Zode.Shell.Diagnostics;
using Zode.Shell.Native;

namespace Zode.Shell.Windowing;

internal sealed class FillScreenController
{
    private readonly Func<IntPtr> _windowHandle;
    private NativeMethods.WINDOWPLACEMENT _savedPlacement;
    private bool _hasSavedPlacement;
    private bool _filling;

    public FillScreenController(Func<IntPtr> windowHandle) => _windowHandle = windowHandle;

    public bool IsFilling => _filling;

    /// <summary>Returns the new state: true when the window now fills the screen.</summary>
    public bool Toggle()
    {
        if (_filling)
        {
            Restore();
            return false;
        }

        Fill();
        return _filling;
    }

    public bool Fill()
    {
        IntPtr hwnd = _windowHandle();
        if (hwnd == IntPtr.Zero)
        {
            return false;
        }

        IntPtr monitor = NativeMethods.MonitorFromWindow(hwnd, WindowConstants.MONITOR_DEFAULTTONEAREST);
        var info = new NativeMethods.MONITORINFO
        {
            cbSize = Marshal.SizeOf<NativeMethods.MONITORINFO>(),
        };

        if (!NativeMethods.GetMonitorInfoW(monitor, ref info))
        {
            Log.Warn("fill", "GetMonitorInfo failed; cannot fill the screen.");
            return false;
        }

        var placement = new NativeMethods.WINDOWPLACEMENT
        {
            length = Marshal.SizeOf<NativeMethods.WINDOWPLACEMENT>(),
        };

        if (NativeMethods.GetWindowPlacement(hwnd, ref placement))
        {
            _savedPlacement = placement;
            _hasSavedPlacement = true;
        }

        // The ENTIRE monitor bounds — the taskbar stays on screen.
        bool ok = NativeMethods.SetWindowPos(hwnd, IntPtr.Zero,
            info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Width, info.rcMonitor.Height,
            WindowConstants.SWP_NOACTIVATE | WindowConstants.SWP_FRAMECHANGED);

        _filling = ok;
        Log.Info("fill", ok
            ? $"filling monitor bounds {info.rcMonitor}"
            : "SetWindowPos failed while filling the screen");
        return ok;
    }

    public void Restore()
    {
        IntPtr hwnd = _windowHandle();
        if (hwnd == IntPtr.Zero)
        {
            return;
        }

        if (_hasSavedPlacement)
        {
            var placement = _savedPlacement;
            NativeMethods.SetWindowPlacement(hwnd, ref placement);
        }

        _filling = false;
        Log.Info("fill", "restored the previous window placement");
    }

    /// <summary>Re-applies the monitor bounds (monitor changed / DPI change).</summary>
    public void ReapplyMonitorBounds()
    {
        if (!_filling)
        {
            return;
        }

        IntPtr hwnd = _windowHandle();
        IntPtr monitor = NativeMethods.MonitorFromWindow(hwnd, WindowConstants.MONITOR_DEFAULTTONEAREST);
        var info = new NativeMethods.MONITORINFO
        {
            cbSize = Marshal.SizeOf<NativeMethods.MONITORINFO>(),
        };

        if (NativeMethods.GetMonitorInfoW(monitor, ref info))
        {
            NativeMethods.SetWindowPos(hwnd, IntPtr.Zero,
                info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Width, info.rcMonitor.Height,
                WindowConstants.SWP_NOACTIVATE | WindowConstants.SWP_FRAMECHANGED);
        }
    }
}
