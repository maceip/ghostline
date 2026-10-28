// Platform/JumpListService.cs — the Windows equivalent of the macOS dock drop.
//
// A Jump List only exists for an app that owns an AppUserModelID and a Start
// Menu shortcut (see AppIdentity) — that is the "registry-free" part: no
// registry key of our own is written, the shell keeps the jump list data in
// its own per-user store.
//
// Two mechanisms are used:
//   1. SHAddToRecentDocs() — every attachment shows up in the "Recent"
//      section of the app's jump list.  This is the reliable path.
//   2. ICustomDestinationList — adds a custom "Zode" task to the jump list.
//      Best effort: the whole call is guarded, and a failure only means the
//      custom section is missing.

using System.Runtime.InteropServices;
using Zode.Shell.Diagnostics;
using Zode.Shell.Interop;
using Zode.Shell.Native;

namespace Zode.Shell.Platform;

internal sealed class JumpListService
{
    private readonly object _sync = new();
    private bool _customTaskFailed;

    /// <summary>Publishes a file in the app's "Recent documents" jump list.</summary>
    public void AddRecentAttachment(string path)
    {
        try
        {
            Shell32.SHAddToRecentDocs(path);
        }
        catch (Exception ex)
        {
            Log.Warn("jumplist", $"SHAddToRecentDocs failed: {ex.Message}");
        }
    }

    /// <summary>Adds the custom "Zode" task to the app's jump list.</summary>
    public void EnsureCustomTask()
    {
        lock (_sync)
        {
            if (_customTaskFailed)
            {
                return;
            }

            try
            {
                if (AppendCustomTask())
                {
                    Log.Info("jumplist", "custom jump list task registered.");
                }
                else
                {
                    _customTaskFailed = true;
                }
            }
            catch (Exception ex)
            {
                _customTaskFailed = true;
                Log.Warn("jumplist", $"custom jump list task unavailable: {ex.Message}");
            }
        }
    }

    private static bool AppendCustomTask()
    {
        Guid clsid = ComIds.CLSID_DestinationList;
        Guid iid = ComIds.IID_ICustomDestinationList;
        int hr = Ole32.CoCreateInstance(ref clsid, IntPtr.Zero, Ole32.CLSCTX_INPROC_SERVER, ref iid, out IntPtr listRaw);
        if (hr != 0 || listRaw == IntPtr.Zero)
        {
            Log.Warn("jumplist", $"ICustomDestinationList is not available (0x{hr:X8}).");
            return false;
        }

        var list = (ICustomDestinationList)Marshal.GetObjectForIUnknown(listRaw);
        IntPtr storeRaw = IntPtr.Zero;
        IntPtr collectionRaw = IntPtr.Zero;
        IntPtr taskListId = IntPtr.Zero;
        try
        {
            list.BeginList(out uint _count, out taskListId, out IntPtr _existing);

            int store = Propsys.PSCoCreatePropertyStore(out storeRaw);
            if (store != 0 || storeRaw == IntPtr.Zero)
            {
                Log.Warn("jumplist", $"PSCoCreatePropertyStore failed (0x{store:X8}).");
                return false;
            }

            var propertyStore = (IPropertyStore)Marshal.GetObjectForIUnknown(storeRaw);
            if (!SetAppUserModelId(propertyStore))
            {
                return false;
            }

            Guid collectionClsid = ComIds.CLSID_EnumerableObjectCollection;
            Guid collectionIid = ComIds.IID_IObjectCollection;
            int created = Ole32.CoCreateInstance(ref collectionClsid, IntPtr.Zero, Ole32.CLSCTX_INPROC_SERVER,
                ref collectionIid, out collectionRaw);
            if (created != 0 || collectionRaw == IntPtr.Zero)
            {
                Log.Warn("jumplist", $"IObjectCollection is not available (0x{created:X8}).");
                return false;
            }

            var collection = (IObjectCollection)Marshal.GetObjectForIUnknown(collectionRaw);
            collection.AddObject(storeRaw);

            list.AppendList(taskListId, collectionRaw);
            list.SaveList();
            return true;
        }
        finally
        {
            if (taskListId != IntPtr.Zero)
            {
                Ole32.CoTaskMemFree(taskListId);
            }

            if (collectionRaw != IntPtr.Zero)
            {
                Marshal.Release(collectionRaw);
            }

            if (storeRaw != IntPtr.Zero)
            {
                Marshal.Release(storeRaw);
            }

            Marshal.Release(listRaw);
        }
    }

    private static bool SetAppUserModelId(IPropertyStore store)
    {
        IntPtr key = Marshal.AllocHGlobal(24);
        IntPtr variant = Marshal.AllocHGlobal(24);
        IntPtr text = IntPtr.Zero;
        try
        {
            Marshal.Copy(ComIds.PKEY_AppUserModelId.ToByteArray(), 0, key, 16);
            Marshal.WriteInt32(key, 16, 5);

            for (int i = 0; i < 24; i++)
            {
                Marshal.WriteByte(variant, i, 0);
            }

            Marshal.WriteInt16(variant, 0, 31); // VT_LPWSTR
            text = Marshal.StringToHGlobalUni(AppIdentity.AppUserModelId);
            Marshal.WriteIntPtr(variant, 8, text);

            int set = store.SetValue(key, variant);
            if (set != 0)
            {
                Ole32.CoTaskMemFree(text);
                text = IntPtr.Zero;
                return false;
            }

            store.Commit(0);
            return true;
        }
        finally
        {
            Marshal.FreeHGlobal(key);
            Marshal.FreeHGlobal(variant);
            if (text != IntPtr.Zero)
            {
                Ole32.CoTaskMemFree(text);
            }
        }
    }
}
