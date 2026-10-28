// Attachments/FileDropTarget.cs — the IDropTarget implementation.
//
// Contract §8: "Drop target must cover the entire window — not just a
// designated box."  The WebView2 renderer is a child HWND that covers the
// whole client area, so the drop target is registered on that child window.
// (The primary path is the WebView2 DragStarting event, which also covers the
// web content; this class is the OLE-level fallback.)

using System.Runtime.InteropServices;
using Zode.Shell.Interop;
using Zode.Shell.Native;

namespace Zode.Shell.Attachments;

[ComVisible(true)]
internal sealed class FileDropTarget : IDropTarget
{
    private readonly Action<IReadOnlyList<string>> _onFiles;
    private bool _accepts;

    public FileDropTarget(Action<IReadOnlyList<string>> onFiles) => _onFiles = onFiles;

    [PreserveSig]
    public int DragEnter(IComDataObject pDataObject, int keyState, POINTL pt, out int pdwEffect)
    {
        pdwEffect = Ole32.DROPEFFECT_NONE;
        try
        {
            IReadOnlyList<string> files = DataObjectReader.GetFilePaths(pDataObject);
            _accepts = files.Count > 0;
            if (_accepts)
            {
                pdwEffect = Ole32.DROPEFFECT_COPY;
            }
        }
        catch (Exception)
        {
            _accepts = false;
        }

        return 0; // S_OK
    }

    [PreserveSig]
    public int DragOver(int keyState, POINTL pt, out int pdwEffect)
    {
        pdwEffect = _accepts ? Ole32.DROPEFFECT_COPY : Ole32.DROPEFFECT_NONE;
        return 0;
    }

    [PreserveSig]
    public int DragLeave()
    {
        _accepts = false;
        return 0;
    }

    [PreserveSig]
    public int Drop(IComDataObject pDataObject, int keyState, POINTL pt, out int pdwEffect)
    {
        pdwEffect = Ole32.DROPEFFECT_NONE;
        try
        {
            IReadOnlyList<string> files = DataObjectReader.GetFilePaths(pDataObject);
            if (files.Count > 0)
            {
                pdwEffect = Ole32.DROPEFFECT_COPY;
                _onFiles(files);
            }
        }
        catch (Exception)
        {
            // The drop is silently ignored rather than crashing the shell.
        }
        finally
        {
            _accepts = false;
        }

        return 0;
    }
}

/// <summary>Registers / unregisters the OLE drop target on a window.</summary>
internal static class DropTargetRegistration
{
    public static bool Register(IntPtr hwnd, FileDropTarget target)
    {
        try
        {
            Guid iid = ComIds.IID_IDropTarget;
            // The cast makes the runtime query for IID_IDropTarget explicitly.
            int hr = Ole32.RegisterDragDrop(hwnd, (IDropTarget)target, ref iid);
            if (hr == 0)
            {
                return true;
            }

            if (hr == Ole32.DRAGDROP_E_ALREADYREGISTERED)
            {
                // The WebView2 renderer already owns the drop target of this
                // HWND — the DragStarting event path takes over.
                return false;
            }

            return false;
        }
        catch (Exception)
        {
            return false;
        }
    }

    public static void Revoke(IntPtr hwnd)
    {
        try
        {
            Ole32.RevokeDragDrop(hwnd);
        }
        catch (Exception)
        {
            // ignored
        }
    }
}
