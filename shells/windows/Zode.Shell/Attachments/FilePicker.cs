// Attachments/FilePicker.cs — the native file picker behind `attach.pick`.
//
// Uses the modern IFileOpenDialog COM API (Vista+) with multi-select; no
// WinForms / Windows App SDK dependency.

using System.Runtime.InteropServices;
using Zode.Shell.Bridge;
using Zode.Shell.Diagnostics;
using Zode.Shell.Interop;
using Zode.Shell.Native;

namespace Zode.Shell.Attachments;

internal sealed class FilePicker
{
    private const uint FOS_ALLOWMULTISELECT = 0x00000200;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint FOS_FILEMUSTEXIST = 0x00001000;
    private const uint FOS_FORCEFILESYSTEM = 0x00040000;
    private const uint FOS_NOCHANGEDIR = 0x00000008;

    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int ERROR_CANCELLED_HRESULT = unchecked((int)0x800704C7);

    private readonly IntPtr _ownerWindow;

    public FilePicker(IntPtr ownerWindow) => _ownerWindow = ownerWindow;

    /// <summary>
    /// Shows the picker.  Returns the chosen attachments, or an empty list when
    /// the user cancelled the dialog.
    /// </summary>
    public IReadOnlyList<Attachment> PickFiles()
    {
        try
        {
            return PickWithOpenDialog();
        }
        catch (Exception ex)
        {
            Log.Warn("attachments", $"IFileOpenDialog failed ({ex.Message}); falling back to IFileDialog.");
            try
            {
                return PickWithDialog();
            }
            catch (Exception fallback)
            {
                Log.Error("attachments", fallback);
                throw new BridgeException(ErrorCodes.Internal, $"The file picker could not be shown: {fallback.Message}");
            }
        }
    }

    private IReadOnlyList<Attachment> PickWithOpenDialog()
    {
        Guid clsid = ComIds.CLSID_FileOpenDialog;
        Guid iid = typeof(IFileOpenDialog).GUID;
        int hr = Ole32.CoCreateInstance(ref clsid, IntPtr.Zero, Ole32.CLSCTX_INPROC_SERVER, ref iid, out IntPtr raw);
        if (hr != 0 || raw == IntPtr.Zero)
        {
            throw new InvalidOperationException($"CoCreateInstance(FileOpenDialog) failed (0x{hr:X8}).");
        }

        var dialog = (IFileOpenDialog)Marshal.GetObjectForIUnknown(raw);
        try
        {
            dialog.SetOptions(FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR);
            dialog.SetTitle("Attach to Zode");

            int shown = dialog.Show(_ownerWindow);
            if (shown != 0)
            {
                if (shown == ERROR_CANCELLED_HRESULT)
                {
                    return Array.Empty<Attachment>();
                }

                throw new InvalidOperationException($"The file dialog failed (0x{shown:X8}).");
            }

            if (dialog.GetResults(out IShellItemArray? items) != 0 || items is null)
            {
                return Array.Empty<Attachment>();
            }

            var attachments = new List<Attachment>();
            items.GetCount(out uint count);
            for (uint i = 0; i < count; i++)
            {
                if (items.GetItemAt(i, out IShellItem? item) != 0 || item is null)
                {
                    continue;
                }

                string? path = GetFileSystemPath(item);
                if (!string.IsNullOrEmpty(path))
                {
                    attachments.Add(AttachmentFactory.FromPath(path, AttachmentSources.Picker));
                }
            }

            return attachments;
        }
        finally
        {
            Marshal.FinalReleaseComObject(dialog);
        }
    }

    private IReadOnlyList<Attachment> PickWithDialog()
    {
        Guid clsid = ComIds.CLSID_FileOpenDialog;
        Guid iid = typeof(IFileDialog).GUID;
        int hr = Ole32.CoCreateInstance(ref clsid, IntPtr.Zero, Ole32.CLSCTX_INPROC_SERVER, ref iid, out IntPtr raw);
        if (hr != 0 || raw == IntPtr.Zero)
        {
            throw new InvalidOperationException($"CoCreateInstance(FileDialog) failed (0x{hr:X8}).");
        }

        var dialog = (IFileDialog)Marshal.GetObjectForIUnknown(raw);
        try
        {
            dialog.SetOptions(FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST | FOS_FORCEFILESYSTEM);
            dialog.SetTitle("Attach to Zode");

            int shown = dialog.Show(_ownerWindow);
            if (shown != 0)
            {
                return Array.Empty<Attachment>();
            }

            if (dialog.GetResult(out IShellItem? item) != 0 || item is null)
            {
                return Array.Empty<Attachment>();
            }

            string? path = GetFileSystemPath(item);
            return string.IsNullOrEmpty(path)
                ? Array.Empty<Attachment>()
                : new[] { AttachmentFactory.FromPath(path, AttachmentSources.Picker) };
        }
        finally
        {
            Marshal.FinalReleaseComObject(dialog);
        }
    }

    private static string? GetFileSystemPath(IShellItem item)
    {
        try
        {
            if (item.GetDisplayName(SIGDN_FILESYSPATH, out IntPtr namePtr) != 0 || namePtr == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                return Marshal.PtrToStringUni(namePtr);
            }
            finally
            {
                Ole32.CoTaskMemFree(namePtr);
            }
        }
        catch (Exception)
        {
            return null;
        }
    }
}
