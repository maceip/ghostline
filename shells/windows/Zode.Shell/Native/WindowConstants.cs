// Native/WindowConstants.cs — Win32 constants used by the Zode shell.

namespace Zode.Shell.Native;

internal static class WindowConstants
{
    // ---- window styles ------------------------------------------------
    // The shell uses WS_POPUP | WS_THICKFRAME | WS_CLIPCHILDREN; the caption
    // styles below are listed for reference and are deliberately NOT used.
    public const uint WS_POPUP = 0x80000000;
    public const uint WS_THICKFRAME = 0x00040000;
    public const uint WS_CLIPCHILDREN = 0x02000000;
    public const uint WS_CAPTION = 0x00C00000;
    public const uint WS_SYSMENU = 0x00080000;
    public const uint WS_MINIMIZEBOX = 0x00020000;
    public const uint WS_MAXIMIZEBOX = 0x00010000;

    // ---- messages ------------------------------------------------------
    public const uint WM_DESTROY = 0x0002;
    public const uint WM_CLOSE = 0x0010;
    public const uint WM_QUIT = 0x0012;
    public const uint WM_ERASEBKGND = 0x0014;
    public const uint WM_SIZE = 0x0005;
    public const uint WM_SIZING = 0x0214;
    public const uint WM_MOVE = 0x0003;
    public const uint WM_DISPLAYCHANGE = 0x007E;
    public const uint WM_GETMINMAXINFO = 0x0024;
    public const uint WM_NCCALCSIZE = 0x0083;
    public const uint WM_NCHITTEST = 0x0084;
    public const uint WM_NCLBUTTONDOWN = 0x00A1;
    public const uint WM_NCLBUTTONDBLCLK = 0x00A3;
    public const uint WM_DPICHANGED = 0x02E0;
    public const uint WM_APP_DISPATCH = 0x8001; // Zode: UI-thread work queue
    public const uint WM_APP_DEEPLINK = 0x8002; // Zode: inbound deep link

    // ---- hit test results ---------------------------------------------
    public const int HTCLIENT = 1;
    public const int HTCAPTION = 2;
    public const int HTLEFT = 10;
    public const int HTRIGHT = 11;
    public const int HTTOP = 12;
    public const int HTTOPLEFT = 13;
    public const int HTTOPRIGHT = 14;
    public const int HTBOTTOM = 15;
    public const int HTBOTTOMLEFT = 16;
    public const int HTBOTTOMRIGHT = 17;

    // ---- SetWindowPos flags -------------------------------------------
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_NOACTIVATE = 0x0010;

    // ---- show commands -------------------------------------------------
    public const int SW_SHOWNORMAL = 1;

    // ---- monitor flags -------------------------------------------------
    public const uint MONITOR_DEFAULTTONEAREST = 2;
    public const uint MONITOR_DEFAULTTOPRIMARY = 1;

    // ---- cursors --------------------------------------------------------
    public const int IDC_ARROW = 32512;
}
