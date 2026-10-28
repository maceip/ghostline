// Native/Ole32.cs — OLE / COM entry points (drag & drop registration, CoCreateInstance).

using System.Runtime.InteropServices;

namespace Zode.Shell.Native;

internal static class Ole32
{
    public const uint CLSCTX_INPROC_SERVER = 0x1;

    public const int DRAGDROP_E_ALREADYREGISTERED = unchecked((int)0x800401D0);

    public const int DROPEFFECT_NONE = 0;
    public const int DROPEFFECT_COPY = 1;

    [DllImport("ole32.dll", ExactSpelling = true, SetLastError = true)]
    public static extern int CoCreateInstance(ref Guid rclsid, IntPtr pUnkOuter, uint clsContext,
        ref Guid riid, out IntPtr ppv);

    [DllImport("ole32.dll", ExactSpelling = true)]
    public static extern void CoTaskMemFree(IntPtr pv);

    [DllImport("ole32.dll", ExactSpelling = true)]
    public static extern void ReleaseStgMedium(IntPtr pStgMedium);

    [DllImport("ole32.dll", ExactSpelling = true, SetLastError = true)]
    public static extern int RegisterDragDrop(IntPtr hwnd,
        [MarshalAs(UnmanagedType.Interface)] object pDropTarget, ref Guid riid);

    [DllImport("ole32.dll", ExactSpelling = true, SetLastError = true)]
    public static extern int RevokeDragDrop(IntPtr hwnd);

    [DllImport("ole32.dll", ExactSpelling = true)]
    public static extern int OleInitialize(IntPtr pvReserved);

    [DllImport("ole32.dll", ExactSpelling = true)]
    public static extern void OleUninitialize();
}
