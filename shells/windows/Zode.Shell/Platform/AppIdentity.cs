// Platform/AppIdentity.cs — AppUserModelID + Start Menu shortcut.
//
// Contract §9: "Unpackaged apps must register an AppUserModelID and a Start
// Menu shortcut for notifications to work."  Without this the toast silently
// disappears, so the shell registers both at start-up.
//
// The registration is per-user (no admin rights, no registry of our own):
//   * SetCurrentProcessExplicitAppUserModelID -> the identity of this process
//   * %APPDATA%\Microsoft\Windows\Start Menu\Programs\Zode.lnk -> the
//     shortcut the shell associates with the AUMID.

using System.Runtime.InteropServices;
using Zode.Shell.Diagnostics;
using Zode.Shell.Interop;
using Zode.Shell.Native;

namespace Zode.Shell.Platform;

internal static class AppIdentity
{
    /// <summary>
    /// The AppUserModelID of the shell.  It must be stable across launches and
    /// must match the AUMID written into the Start Menu shortcut.
    /// </summary>
    public const string AppUserModelId = "Zode.NativeShell.4c1f9a2e";

    /// <summary>Display name used for the shortcut.</summary>
    public const string DisplayName = "Zode";

    public static string ShortcutPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Microsoft", "Windows", "Start Menu", "Programs", "Zode.lnk");

    /// <summary>Registers the process AUMID and refreshes the Start Menu shortcut.</summary>
    public static void Register()
    {
        try
        {
            int hr = Shell32.SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
            if (hr != 0)
            {
                Log.Warn("identity", $"SetCurrentProcessExplicitAppUserModelID failed (0x{hr:X8}).");
            }
        }
        catch (Exception ex)
        {
            Log.Warn("identity", $"could not set the AppUserModelID: {ex.Message}");
        }

        try
        {
            CreateShortcut();
        }
        catch (Exception ex)
        {
            Log.Warn("identity", $"could not create the Start Menu shortcut: {ex.Message}");
        }
    }

    /// <summary>Creates (or refreshes) the per-user Start Menu shortcut.</summary>
    public static void CreateShortcut()
    {
        string exePath = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exePath))
        {
            return;
        }

        string shortcutPath = ShortcutPath;
        Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath)!);

        Guid clsid = ComIds.CLSID_ShellLink;
        Guid iid = ComIds.IID_IShellLinkW;
        int hr = Ole32.CoCreateInstance(ref clsid, IntPtr.Zero, Ole32.CLSCTX_INPROC_SERVER, ref iid, out IntPtr raw);
        if (hr != 0 || raw == IntPtr.Zero)
        {
            Log.Warn("identity", $"CoCreateInstance(ShellLink) failed (0x{hr:X8}).");
            return;
        }

        var link = (IShellLinkW)Marshal.GetObjectForIUnknown(raw);
        try
        {
            link.SetPath(exePath);
            link.SetWorkingDirectory(Path.GetDirectoryName(exePath) ?? AppContext.BaseDirectory);
            link.SetDescription("Zode — the Zune for Windows");
            link.SetIconLocation(exePath, 0);
            link.SetArguments(string.Empty);

            WriteAppUserModelId(link);

            Guid persistId = ComIds.IID_IPersistFile;
            int query = Marshal.QueryInterface(raw, ref persistId, out IntPtr persistRaw);
            if (query != 0 || persistRaw == IntPtr.Zero)
            {
                Log.Warn("identity", "the shell link does not support IPersistFile.");
                return;
            }

            try
            {
                var persist = (IPersistFile)Marshal.GetObjectForIUnknown(persistRaw);
                persist.Save(shortcutPath, 1);
            }
            finally
            {
                Marshal.Release(persistRaw);
            }

            Log.Info("identity", $"Start Menu shortcut written to {shortcutPath}");
        }
        finally
        {
            Marshal.FinalReleaseComObject(link);
        }
    }

    /// <summary>
    /// Writes "System.AppUserModel.ID" into the shell link's property store.
    /// This is what makes the shell (and the taskbar) associate the shortcut
    /// with our AUMID.
    /// </summary>
    private static void WriteAppUserModelId(IShellLinkW link)
    {
        Guid storeId = ComIds.IID_IPropertyStore;
        int hr = Propsys.PSGetPropertyStoreFromShellLink(link, ref storeId, out IntPtr storeRaw);
        if (hr != 0 || storeRaw == IntPtr.Zero)
        {
            Log.Warn("identity", $"PSGetPropertyStoreFromShellLink failed (0x{hr:X8}); the AUMID may not stick.");
            return;
        }

        var store = (IPropertyStore)Marshal.GetObjectForIUnknown(storeRaw);
        IntPtr key = Marshal.AllocHGlobal(24);
        IntPtr variant = Marshal.AllocHGlobal(24);
        IntPtr text = IntPtr.Zero;
        try
        {
            byte[] guidBytes = ComIds.PKEY_AppUserModelId.ToByteArray();
            Marshal.Copy(guidBytes, 0, key, 16);
            Marshal.WriteInt32(key, 16, 5); // pid of System.AppUserModel.ID

            for (int i = 0; i < 24; i++)
            {
                Marshal.WriteByte(variant, i, 0);
            }

            Marshal.WriteInt16(variant, 0, 31); // VT_LPWSTR
            text = Marshal.StringToHGlobalUni(AppUserModelId);
            Marshal.WriteIntPtr(variant, 8, text);

            int set = store.SetValue(key, variant);
            if (set == 0)
            {
                store.Commit(0);
            }
            else
            {
                Log.Warn("identity", $"IPropertyStore::SetValue failed (0x{set:X8}).");
                Ole32.CoTaskMemFree(text);
                text = IntPtr.Zero;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(key);
            Marshal.FreeHGlobal(variant);
            if (text != IntPtr.Zero)
            {
                Ole32.CoTaskMemFree(text);
            }

            Marshal.Release(storeRaw);
        }
    }
}
