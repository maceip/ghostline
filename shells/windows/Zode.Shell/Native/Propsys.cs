// Native/Propsys.cs — propsys.dll entry points used for shell-link
// property stores (AppUserModelID) and jump-list custom destinations.

using System.Runtime.InteropServices;

namespace Zode.Shell.Native;

internal static class Propsys
{
    /// <summary>
    /// Returns the property store that belongs to a shell link.  Used to write
    /// "System.AppUserModel.ID" (the AUMID) into a .lnk — mandatory for
    /// notifications to work in an unpackaged app (contract §9).
    /// </summary>
    [DllImport("propsys.dll", ExactSpelling = true, PreserveSig = true)]
    public static extern int PSGetPropertyStoreFromShellLink(
        [MarshalAs(UnmanagedType.Interface)] object pShellLink, ref Guid riid, out IntPtr ppv);

    /// <summary>Creates an in-memory property store (jump-list tasks).</summary>
    [DllImport("propsys.dll", ExactSpelling = true, PreserveSig = true)]
    public static extern int PSCoCreatePropertyStore(out IntPtr ppv);
}
